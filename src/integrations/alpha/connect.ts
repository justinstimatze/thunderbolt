/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { AuthorizationServerMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { http } from '@/lib/http'
import { alphaCallbackPath, alphaScope, type AlphaConfig } from './config'
import { SyncError } from './errors'
import { credentialsLockName, withLock } from './locks'
import {
  clearIdMap,
  clearSkipRecords,
  deleteAlphaConnection,
  deleteMeta,
  getAlphaConnection,
  getMeta,
  getSharedSyncFrom,
  metaKeys,
  saveAlphaConnection,
  setMeta,
  setSharedSyncFrom,
  type AlphaConnection,
  type AlphaCredentials,
} from './storage'

/*
 * OAuth 2.1 authorization code + PKCE against AI Potluck, using the MCP SDK's client helpers
 * (already a Thunderbolt dependency) for RFC 8414 discovery, the authorization URL and the token
 * calls. No endpoint path is hard-coded: everything comes from the discovered metadata.
 *
 * Thunderbolt's web build sends `Cross-Origin-Opener-Policy: same-origin`, which severs a
 * cross-origin popup's `window.opener`, so this is a full-page redirect, like the Google and
 * Microsoft connections. The pending flow (state, PKCE verifier) waits in localStorage until
 * `/oauth/alpha/callback` completes it, for at most {@link pendingFlowTtlMs}.
 *
 * Every request here has a time limit: a refresh runs under the cross-tab credentials lock, and
 * sign-out waits on that lock.
 */

const pendingFlowKey = 'alpha_oauth_flow'

/** A sign-in that has not come back from AI Potluck's consent page by now is abandoned. */
export const pendingFlowTtlMs = 10 * 60_000

/** Time limit for each discovery and token request. */
export const oauthRequestTimeoutMs = 15_000

/** How long Disconnect waits for a refresh in another tab to let go of the tokens before going ahead. */
export const disconnectLockWaitMs = 5000

/** `fetch` with a time limit, for the MCP SDK's OAuth helpers, which set none of their own. */
export const fetchWithTimeout =
  (timeoutMs: number): FetchLike =>
  (url, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  }

const isNamed = (error: unknown, ...names: string[]) =>
  typeof error === 'object' && error !== null && 'name' in error && names.includes(String(error.name))

/** fetch rejects with a TypeError when offline; a time limit rejects with a TimeoutError. */
const isUnreachable = (error: unknown) => error instanceof TypeError || isNamed(error, 'TimeoutError')

/** Why connecting failed, as a code the card turns into a translated sentence. */
export type ConnectErrorCode =
  | 'not-configured'
  | 'no-metadata'
  | 'foreign-endpoints'
  | 'declined'
  | 'no-code'
  | 'not-started-here'
  | 'exchange-failed'
  | 'offline'

export class ConnectError extends Error {
  readonly code: ConnectErrorCode
  constructor(code: ConnectErrorCode, options: { cause?: unknown } = {}) {
    super(code, options)
    this.name = 'ConnectError'
    this.code = code
  }
}

type PendingFlow = { state: string; verifier: string; origin: string; redirectUri: string; startedAt: number }

const clientInformation = (config: AlphaConfig) => ({
  client_id: config.clientId,
  token_endpoint_auth_method: 'none',
})

/** The redirect URI registered for this client: this app's own origin plus the callback route. */
export const alphaRedirectUri = (origin = window.location.origin) => `${origin}${alphaCallbackPath}`

const toCredentials = (tokens: OAuthTokens, previous?: AlphaCredentials, now = Date.now()): AlphaCredentials => ({
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? null,
  expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : null,
})

/** Discover AI Potluck's authorization server, refusing any endpoint on another origin. */
export const discoverAlpha = async (
  origin: string,
  fetchFn: FetchLike = fetchWithTimeout(oauthRequestTimeoutMs),
): Promise<AuthorizationServerMetadata> => {
  let metadata: AuthorizationServerMetadata | undefined
  try {
    metadata = await discoverAuthorizationServerMetadata(origin, { fetchFn })
  } catch (error) {
    throw new ConnectError(isUnreachable(error) ? 'offline' : 'no-metadata', { cause: error })
  }
  if (!metadata) {
    throw new ConnectError('no-metadata')
  }
  // Everything the flow talks to must live on the configured origin, so a discovery document can't
  // send the code or the tokens anywhere else.
  const sameOrigin = (url: string | undefined) => {
    try {
      return url !== undefined && new URL(url).origin === origin
    } catch {
      return false
    }
  }
  const revocation = 'revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined
  const endpoints = [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint]
  if (!endpoints.every(sameOrigin) || (revocation !== undefined && !sameOrigin(revocation))) {
    throw new ConnectError('foreign-endpoints')
  }
  return metadata
}

/** Begin connecting: discover, build the authorization URL, and leave for AI Potluck's consent page. */
export const startAlphaConnect = async (
  config: AlphaConfig,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> => {
  const metadata = await discoverAlpha(config.origin)
  const state = crypto.randomUUID()
  const redirectUri = alphaRedirectUri()
  const { authorizationUrl, codeVerifier } = await startAuthorization(config.origin, {
    metadata,
    clientInformation: clientInformation(config),
    redirectUrl: redirectUri,
    scope: alphaScope,
    state,
  })
  const pending: PendingFlow = {
    state,
    verifier: codeVerifier,
    origin: config.origin,
    redirectUri,
    startedAt: Date.now(),
  }
  localStorage.setItem(pendingFlowKey, JSON.stringify(pending))
  navigate(authorizationUrl.toString())
}

/** The pending flow, once: it is removed on read, and one older than {@link pendingFlowTtlMs} counts as none. */
const takePendingFlow = (now = Date.now()): PendingFlow | null => {
  const raw = localStorage.getItem(pendingFlowKey)
  localStorage.removeItem(pendingFlowKey)
  let pending: PendingFlow | null
  try {
    pending = raw ? (JSON.parse(raw) as PendingFlow) : null
  } catch {
    return null
  }
  const age = typeof pending?.startedAt === 'number' ? now - pending.startedAt : Infinity
  return pending && age >= 0 && age <= pendingFlowTtlMs ? pending : null
}

/**
 * This device's sync window, in epoch ms: the earlier of its own and the one the account's devices
 * share (see `getSharedSyncFrom`), or `now` when there is neither. Both are set to it, so a browser
 * that connects after another syncs the chats the other already syncs, in both directions. The
 * window only ever moves earlier: nothing deletes it but a move to another server.
 */
export const settleSyncFrom = async (db: AnyDrizzleDatabase, origin: string, now = Date.now()): Promise<number> => {
  const own = Number(await getMeta(db, metaKeys.syncFrom))
  const shared = await getSharedSyncFrom(db, origin)
  const known = [own, shared ?? 0].filter((ms) => Number.isFinite(ms) && ms > 0)
  const from = known.length ? Math.min(...known) : now
  if (from !== own) {
    await setMeta(db, metaKeys.syncFrom, String(from))
  }
  if (from !== shared) {
    await setSharedSyncFrom(db, origin, from)
  }
  return from
}

/**
 * Prepare the bookkeeping for a new connection. The id map belongs to one server, so moving to
 * another starts it over. `syncFrom` marks when the account's first connection to that server
 * began: chats started before it stay on the device. Reconnecting, after Disconnect or a sign-out,
 * keeps it, so every chat that synced before keeps syncing.
 */
export const beginSyncState = async (db: AnyDrizzleDatabase, origin: string, now = Date.now()): Promise<void> => {
  if ((await getMeta(db, metaKeys.origin)) !== origin) {
    await clearIdMap(db)
    await deleteMeta(db, [metaKeys.cursor, metaKeys.replayFrom, metaKeys.syncFrom])
    await setMeta(db, metaKeys.origin, origin)
  }
  await settleSyncFrom(db, origin, now)
}

/**
 * Finish connecting from the callback's `code`, `state` and `iss`; throws when they don't match this
 * device's flow. Per RFC 9207, an `iss` must name the issuer this flow discovered, and a server that
 * says it always sends one must have, before the code is sent anywhere.
 */
export const completeAlphaConnect = async (
  db: AnyDrizzleDatabase,
  config: AlphaConfig,
  { code, state, iss = null }: { code: string; state: string; iss?: string | null },
): Promise<AlphaConnection> => {
  const pending = takePendingFlow()
  if (!pending || pending.state !== state || pending.origin !== config.origin) {
    throw new ConnectError('not-started-here')
  }
  const metadata = await discoverAlpha(pending.origin)
  const sendsIssuer =
    (metadata as { authorization_response_iss_parameter_supported?: unknown })
      .authorization_response_iss_parameter_supported === true
  if (iss === null ? sendsIssuer : iss !== metadata.issuer) {
    throw new ConnectError('foreign-endpoints')
  }
  let tokens: OAuthTokens
  try {
    tokens = await exchangeAuthorization(pending.origin, {
      metadata,
      clientInformation: clientInformation(config),
      authorizationCode: code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      fetchFn: fetchWithTimeout(oauthRequestTimeoutMs),
    })
  } catch (error) {
    throw new ConnectError(isUnreachable(error) ? 'offline' : 'exchange-failed', { cause: error })
  }
  const connection = { origin: pending.origin, metadata, credentials: toCredentials(tokens) }
  await withLock(credentialsLockName, async () => {
    await beginSyncState(db, connection.origin)
    await saveAlphaConnection(db, connection)
  })
  return connection
}

/** True when the access token expires within a minute. */
export const isExpiring = (credentials: AlphaCredentials, now = Date.now()) =>
  credentials.expiresAt !== null && credentials.expiresAt - 60_000 <= now

type FreshOptions = {
  /** The token a request just had refused: refresh unless another caller already replaced it. */
  refused?: string
  refresh?: typeof refreshAuthorization
  /** Time limit for the refresh request. */
  timeoutMs?: number
}

/**
 * The stored connection with an access token worth using, refreshing it first when it is about to
 * expire or was just refused. Single-flight: the read, the refresh and the write happen under one
 * lock shared by every tab, and a caller that waited re-reads the row and finds the token another
 * caller already refreshed. Two refreshes with one refresh token would look like token theft to
 * the server, which then revokes the grant.
 *
 * Throws a `reauth` SyncError only when the server refuses the refresh token (or there is none),
 * or the connection was removed while the refresh was in flight; a network or server failure
 * during refresh, a timeout included, stays retryable.
 */
export const getFreshConnection = (
  db: AnyDrizzleDatabase,
  config: AlphaConfig,
  { refused, refresh = refreshAuthorization, timeoutMs = oauthRequestTimeoutMs }: FreshOptions = {},
): Promise<AlphaConnection> =>
  withLock(credentialsLockName, async () => {
    const connection = await getAlphaConnection(db)
    if (!connection || connection.origin !== config.origin) {
      throw new SyncError('reauth', 'signed-out')
    }
    const stale =
      refused !== undefined ? connection.credentials.accessToken === refused : isExpiring(connection.credentials)
    if (!stale) {
      return connection
    }
    if (!connection.credentials.refreshToken) {
      throw new SyncError('reauth', 'signed-out')
    }
    const tokens = await refresh(connection.origin, {
      metadata: connection.metadata,
      clientInformation: clientInformation(config),
      refreshToken: connection.credentials.refreshToken,
      fetchFn: fetchWithTimeout(timeoutMs),
    })
    const next = { ...connection, credentials: toCredentials(tokens, connection.credentials) }
    // Disconnect goes ahead without the lock once its wait runs out, so the connection may be gone
    // by now; saving the new tokens would bring it back. Disconnect revoked the old tokens, not
    // these, so revoke them here.
    const current = await getAlphaConnection(db)
    if (current?.credentials.refreshToken !== connection.credentials.refreshToken) {
      await revoke(next, config)
      throw new SyncError('reauth', 'signed-out')
    }
    await saveAlphaConnection(db, next)
    return next
  })

const revocationTimeoutMs = 5000

/** Ask AI Potluck to revoke both tokens. Best effort and bounded: the local tokens are gone already. */
const revoke = async (connection: AlphaConnection, config: AlphaConfig | null): Promise<void> => {
  // The discovered metadata is RFC 8414 or OIDC; only the former types revocation_endpoint.
  const endpoint = 'revocation_endpoint' in connection.metadata ? connection.metadata.revocation_endpoint : undefined
  if (!endpoint || !config) {
    return
  }
  const tokens = [
    [connection.credentials.refreshToken, 'refresh_token'],
    [connection.credentials.accessToken, 'access_token'],
  ] as const
  const results = await Promise.allSettled(
    tokens.flatMap(([token, hint]) =>
      token
        ? [
            http.post(endpoint, {
              body: new URLSearchParams({ token, token_type_hint: hint, client_id: config.clientId }),
              timeout: revocationTimeoutMs,
            }),
          ]
        : [],
    ),
  )
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('AI Potluck token revocation failed', result.reason)
    }
  }
}

/**
 * Disconnect this device: forget the tokens, the stream cursor and the records of what the stream
 * skipped (reading it again from the start finds those again), then ask AI Potluck to revoke the
 * grant. The id map and the sync window stay, so connecting again maps the same rows to the same
 * ids and keeps syncing every chat that synced before. Also runs on sign-out, device revocation and
 * account deletion, so the grant never outlives the account on this device.
 *
 * It waits at most `lockWaitMs` for the credentials lock (a refresh in another tab holds it), then
 * forgets the tokens anyway: sign-out must not wait on AI Potluck. A refresh that finishes later
 * finds the connection gone and does not save.
 */
export const disconnectAlpha = async (
  db: AnyDrizzleDatabase,
  config: AlphaConfig | null,
  { lockWaitMs = disconnectLockWaitMs }: { lockWaitMs?: number } = {},
): Promise<void> => {
  const forget = async () => {
    const stored = await getAlphaConnection(db)
    await deleteAlphaConnection(db)
    await deleteMeta(db, [metaKeys.cursor, metaKeys.replayFrom])
    await clearSkipRecords(db)
    return stored
  }
  let connection: AlphaConnection | null
  try {
    connection = await withLock(credentialsLockName, forget, AbortSignal.timeout(lockWaitMs))
  } catch (error) {
    if (!isNamed(error, 'TimeoutError', 'AbortError')) {
      throw error
    }
    connection = await forget()
  }
  if (connection) {
    await revoke(connection, config)
  }
}
