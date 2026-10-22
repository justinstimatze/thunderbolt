/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { AlphaConfig } from './config'
import { beginSyncState, completeAlphaConnect, disconnectAlpha, getFreshConnection, pendingFlowTtlMs } from './connect'
import { classifyError, SyncError } from './errors'
import { uuidv7Floor } from './ids'
import { toInbound } from './map'
import { emptyIdMap, planInbound, planOutbound } from './plan'
import {
  deleteMeta,
  getAlphaConnection,
  getConnectionState,
  getMeta,
  getSharedSyncFrom,
  loadIdMap,
  metaKeys,
  saveAlphaConnection,
  saveMapEntries,
  setMeta,
  type AlphaCredentials,
} from './storage'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
})

const config: AlphaConfig = { origin: 'https://alpha.example', clientId: 'thunderbolt-test' }

const metadata = {
  issuer: config.origin,
  authorization_endpoint: `${config.origin}/authorize`,
  token_endpoint: `${config.origin}/token`,
  response_types_supported: ['code'],
} as AuthorizationServerMetadata

const store = (credentials: Partial<AlphaCredentials> = {}) =>
  saveAlphaConnection(getDb(), {
    origin: config.origin,
    metadata,
    credentials: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null, ...credentials },
  })

/** A refresh that counts its calls and takes a moment, like a real token request. */
const countingRefresh = () => {
  let calls = 0
  const refresh = async () => {
    calls += 1
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    return {
      access_token: `access-${calls + 1}`,
      refresh_token: `refresh-${calls + 1}`,
      token_type: 'Bearer',
      expires_in: 3600,
    }
  }
  return { refresh: refresh as never, calls: () => calls }
}

describe('getFreshConnection', () => {
  it('refreshes an expiring token once however many callers ask at the same moment', async () => {
    await store({ expiresAt: Date.now() })
    const { refresh, calls } = countingRefresh()
    const results = await Promise.all(Array.from({ length: 5 }, () => getFreshConnection(getDb(), config, { refresh })))
    expect(calls()).toBe(1)
    expect(new Set(results.map((r) => r.credentials.accessToken))).toEqual(new Set(['access-2']))
    expect((await getAlphaConnection(getDb()))?.credentials.refreshToken).toBe('refresh-2')
  })

  it('does not refresh again for a refused token another caller already replaced', async () => {
    await store()
    const { refresh, calls } = countingRefresh()
    const [first, second] = await Promise.all([
      getFreshConnection(getDb(), config, { refused: 'access-1', refresh }),
      getFreshConnection(getDb(), config, { refused: 'access-1', refresh }),
    ])
    expect(calls()).toBe(1)
    expect(first.credentials.accessToken).toBe(second.credentials.accessToken)
  })

  it('uses a token that is still good without touching the server', async () => {
    await store({ expiresAt: Date.now() + 3_600_000 })
    const { refresh, calls } = countingRefresh()
    expect((await getFreshConnection(getDb(), config, { refresh })).credentials.accessToken).toBe('access-1')
    expect(calls()).toBe(0)
  })

  it('signs out only when the refresh token is refused or missing, never on a failed request', async () => {
    await store({ expiresAt: Date.now() })
    const refused = (async () => {
      throw new InvalidGrantError('revoked')
    }) as never
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as never
    expect(classifyError(await getFreshConnection(getDb(), config, { refresh: refused }).catch((e) => e)).kind).toBe(
      'reauth',
    )
    expect(classifyError(await getFreshConnection(getDb(), config, { refresh: down }).catch((e) => e)).kind).toBe(
      'transient',
    )
    await store({ expiresAt: Date.now(), refreshToken: null })
    expect(await getFreshConnection(getDb(), config).catch((e) => e)).toMatchObject({ kind: 'reauth' })
  })

  it('gives up on a refresh request that hangs, keeping the stored tokens and staying retryable', async () => {
    await store({ expiresAt: 0 })
    const realFetch = globalThis.fetch
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    try {
      const error = await getFreshConnection(getDb(), config, { timeoutMs: 50 }).catch((e) => e)
      expect(classifyError(error)).toMatchObject({ kind: 'transient', code: 'timeout' })
    } finally {
      globalThis.fetch = realFetch
    }
    expect((await getAlphaConnection(getDb()))?.credentials.refreshToken).toBe('refresh-1')
  })

  it('refuses a stored connection to another server than the one this build is configured for', async () => {
    await store()
    const error = await getFreshConnection(getDb(), { ...config, origin: 'https://other.example' }).catch((e) => e)
    expect(error).toBeInstanceOf(SyncError)
    expect(error).toMatchObject({ kind: 'reauth' })
    expect(await getConnectionState(getDb(), 'https://other.example')).toMatchObject({ status: 'signed-out' })
  })
})

describe('disconnectAlpha', () => {
  it('forgets the tokens and cursor but keeps the id map and sync window, so reconnecting duplicates and skips nothing', async () => {
    const db = getDb()
    await store()
    await setMeta(db, metaKeys.cursor, 'c9')
    await setMeta(db, metaKeys.syncFrom, '1')
    await saveMapEntries(db, [{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'local', title: 'x' }])
    await disconnectAlpha(db, config)
    expect(await getAlphaConnection(db)).toBeNull()
    expect(await getConnectionState(db, config.origin)).toEqual({ status: 'none' })
    expect(await getMeta(db, metaKeys.cursor)).toBeNull()
    expect(await getMeta(db, metaKeys.syncFrom)).toBe('1')
    expect((await loadIdMap(db)).threads.get('T1')?.remoteId).toBe('conv-1')
  })

  it('keeps the account’s shared sync window, so a browser that connects after every other disconnected opens no later one', async () => {
    const db = getDb()
    const firstConnect = 1_700_000_000_000
    await beginSyncState(db, config.origin, firstConnect)
    await store()
    await disconnectAlpha(db, config)
    expect(await getSharedSyncFrom(db, config.origin)).toBe(firstConnect)
    // Another browser: none of this one's local bridge state, only the synced settings.
    await deleteMeta(db, [metaKeys.syncFrom, metaKeys.origin])
    await beginSyncState(db, config.origin, firstConnect + 86_400_000)
    expect(await getMeta(db, metaKeys.syncFrom)).toBe(String(firstConnect))
    expect(await getSharedSyncFrom(db, config.origin)).toBe(firstConnect)
  })

  it('forgets the records of what the stream skipped, and only those, since the next connect reads it from the start', async () => {
    const db = getDb()
    await store()
    await saveMapEntries(db, [
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'local', title: 'x' },
      { kind: 'thread', localId: 'skipped:conv-bad', remoteId: null, source: 'remote', rejected: 'unreadable' },
      { kind: 'thread', localId: 'skipped-event:c4', remoteId: null, source: 'remote', rejected: 'too-many' },
    ])
    await disconnectAlpha(db, config)
    expect([...(await loadIdMap(db)).threads.keys()]).toEqual(['T1'])
  })

  it('goes ahead after its lock wait while a refresh hangs, and the late refresh does not bring the tokens back', async () => {
    const db = getDb()
    await store({ expiresAt: 0 })
    let finish: ((tokens: object) => void) | null = null
    const hanging = (() =>
      new Promise((resolve) => {
        finish = resolve
      })) as never
    const refreshing = getFreshConnection(db, config, { refresh: hanging }).catch((e) => e)
    while (!finish) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await disconnectAlpha(db, null, { lockWaitMs: 50 })
    expect(await getAlphaConnection(db)).toBeNull()
    ;(finish as (tokens: object) => void)({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      token_type: 'Bearer',
    })
    expect(classifyError(await refreshing)).toMatchObject({ kind: 'reauth' })
    expect(await getAlphaConnection(db)).toBeNull()
  })
})

describe('a refresh that finishes after disconnect', () => {
  const realFetch = globalThis.fetch

  it('revokes the tokens it was given, since disconnect revoked only the ones it knew', async () => {
    const db = getDb()
    await saveAlphaConnection(db, {
      origin: config.origin,
      metadata: { ...metadata, revocation_endpoint: `${config.origin}/revoke` } as AuthorizationServerMetadata,
      credentials: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 0 },
    })
    const revoked: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input as Request
      revoked.push(new URLSearchParams(await request.text()).get('token') ?? '')
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch
    try {
      let finish: ((tokens: object) => void) | null = null
      const hanging = (() =>
        new Promise((resolve) => {
          finish = resolve
        })) as never
      const refreshing = getFreshConnection(db, config, { refresh: hanging }).catch((e) => e)
      while (!finish) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      await disconnectAlpha(db, null, { lockWaitMs: 50 })
      ;(finish as (tokens: object) => void)({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
      })
      expect(classifyError(await refreshing)).toMatchObject({ kind: 'reauth' })
      expect(revoked.sort()).toEqual(['access-2', 'refresh-2'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('completeAlphaConnect', () => {
  it('refuses a sign-in that did not come back from AI Potluck within the time limit', async () => {
    localStorage.setItem(
      'alpha_oauth_flow',
      JSON.stringify({
        state: 's1',
        verifier: 'v1',
        origin: config.origin,
        redirectUri: `${config.origin}/oauth/alpha/callback`,
        startedAt: Date.now() - pendingFlowTtlMs - 1,
      }),
    )
    const error = await completeAlphaConnect(getDb(), config, { code: 'c1', state: 's1' }).catch((e) => e)
    expect(error).toMatchObject({ code: 'not-started-here' })
    expect(localStorage.getItem('alpha_oauth_flow')).toBeNull()
  })

  it('never sends the code when the callback names another issuer, or none from a server that always names one', async () => {
    const realFetch = globalThis.fetch
    const tokenRequests: string[] = []
    const serve = (extra: object) =>
      (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('/.well-known/')) {
          return Response.json({ ...metadata, ...extra })
        }
        tokenRequests.push(url)
        return Response.json({ access_token: 'a', token_type: 'Bearer' })
      }) as typeof fetch
    const startFlow = () =>
      localStorage.setItem(
        'alpha_oauth_flow',
        JSON.stringify({
          state: 's1',
          verifier: 'v1',
          origin: config.origin,
          redirectUri: `${config.origin}/oauth/alpha/callback`,
          startedAt: Date.now(),
        }),
      )
    try {
      globalThis.fetch = serve({})
      startFlow()
      const foreign = { code: 'c1', state: 's1', iss: 'https://evil.example' }
      expect(await completeAlphaConnect(getDb(), config, foreign).catch((e) => e)).toMatchObject({
        code: 'foreign-endpoints',
      })
      globalThis.fetch = serve({ authorization_response_iss_parameter_supported: true })
      startFlow()
      expect(await completeAlphaConnect(getDb(), config, { code: 'c1', state: 's1' }).catch((e) => e)).toMatchObject({
        code: 'foreign-endpoints',
      })
      expect(tokenRequests).toEqual([])
      startFlow()
      await completeAlphaConnect(getDb(), config, { code: 'c1', state: 's1', iss: config.origin })
      expect(tokenRequests).toEqual([metadata.token_endpoint])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('beginSyncState', () => {
  it('starts the id map over when the connection moves to another server, and keeps it otherwise', async () => {
    const db = getDb()
    await beginSyncState(db, config.origin, 1000)
    await saveMapEntries(db, [{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'local', title: 'x' }])
    await beginSyncState(db, config.origin, 2000)
    expect((await loadIdMap(db)).threads.size).toBe(1)
    expect(await getMeta(db, metaKeys.syncFrom)).toBe('1000')
    await beginSyncState(db, 'https://other.example', 3000)
    expect((await loadIdMap(db)).threads.size).toBe(0)
    expect(await getMeta(db, metaKeys.syncFrom)).toBe('3000')
  })

  it('gives a browser that connects later the window an earlier browser opened, so it syncs that browser’s chats both ways', async () => {
    const db = getDb()
    const connectedAt = Date.parse('2026-10-15T00:00:00.000Z')
    // Browser A connects, then starts a chat that it pushes.
    await beginSyncState(db, config.origin, connectedAt)
    const chatId = uuidv7Floor(Date.parse('2026-10-16T00:00:00.000Z'))
    // Browser B holds the same synced rows but none of A's local-only bridge state, and connects later.
    await deleteMeta(db, [metaKeys.syncFrom])
    await beginSyncState(db, config.origin, Date.parse('2026-10-18T00:00:00.000Z'))
    const syncFrom = uuidv7Floor(Number(await getMeta(db, metaKeys.syncFrom)))

    const chat = { id: chatId, title: 'Bread', isEncrypted: 0, deletedAt: null }
    const reply = await toInbound(
      {
        v: 1,
        cursor: 'c',
        tombstones: [],
        conversations: [
          {
            id: 'conv-1',
            clientId: chatId,
            origin: config.clientId,
            title: 'Bread',
            createdAt: '2026-10-16T00:00:00.000Z',
            updatedAt: '2026-10-19T00:00:00.000Z',
            messages: [
              {
                id: 'm9',
                clientId: null,
                role: 'assistant',
                content: 'hi',
                createdAt: '2026-10-19T00:00:00.000Z',
                origin: 'web',
              },
            ],
          },
        ],
      },
      { clientId: config.clientId, now: Date.parse('2026-10-20T00:00:00.000Z') },
    )
    const inbound = planInbound(reply, emptyIdMap(), { threads: [chat], messages: [] }, { syncFrom })
    expect(inbound.insertMessages.flatMap((g) => g.messages.map((m) => m.remoteId))).toEqual(['m9'])
    const mine = {
      id: uuidv7Floor(Date.parse('2026-10-19T00:00:00.000Z')),
      threadId: chatId,
      role: 'user',
      text: 'x',
      deletedAt: null,
      isStreaming: false,
    }
    const outbound = planOutbound({ threads: [chat], messages: [mine] }, emptyIdMap(), {
      isSettled: () => true,
      isStalled: () => false,
      createdAt: () => 'x',
      syncFrom,
      maxContentChars: 100,
    })
    expect(outbound.batch.messages.map((m) => m.localId)).toEqual([mine.id])
  })
})
