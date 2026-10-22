/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { ZodError } from 'zod'
import { HttpError } from '@/lib/http'

/**
 * How the bridge reacts to a failure:
 * - `transient`: retry soon with backoff (offline, timeout, 5xx, 429, a stalled stream).
 * - `paused`: retry slowly. The server answered but won't sync right now (403, 404, a reply this
 *   build can't read). Nothing the person does on this device fixes it, but it may pass.
 * - `rejected`: the server refused this request's body (400, 413). Push splits the batch to find
 *   the row; pull treats it as `paused`.
 * - `reauth`: the refresh token was refused. The only failure that stops the bridge; the person
 *   reconnects from the card.
 */
export type SyncFailureKind = 'transient' | 'paused' | 'rejected' | 'reauth'

export type SyncErrorCode =
  | 'offline'
  | 'timeout'
  | 'server-error'
  | 'rate-limited'
  | 'stream-stalled'
  | 'stream-ended'
  | 'rejected'
  | 'token-refused'
  | 'not-permitted'
  | 'sync-off'
  | 'unreadable'
  | 'no-model'
  | 'inbound-limit'
  | 'local-data'
  | 'signed-out'
  | 'unknown'

export class SyncError extends Error {
  readonly kind: SyncFailureKind
  readonly code: SyncErrorCode
  /** The server's Retry-After, when it sent one. */
  readonly retryAfterMs: number | null

  constructor(
    kind: SyncFailureKind,
    code: SyncErrorCode,
    options: { cause?: unknown; retryAfterMs?: number | null } = {},
  ) {
    super(`${kind}: ${code}`, { cause: options.cause })
    this.name = 'SyncError'
    this.kind = kind
    this.code = code
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

/** Retry-After in milliseconds: delta-seconds or an HTTP date. */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | null => {
  if (!value) {
    return null
  }
  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

const fromStatus = (response: Response, cause: unknown): SyncError => {
  const { status } = response
  const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'))
  if (status === 429) {
    return new SyncError('transient', 'rate-limited', { cause, retryAfterMs })
  }
  if (status === 408 || status === 425 || status >= 500) {
    return new SyncError('transient', 'server-error', { cause, retryAfterMs })
  }
  if (status === 400 || status === 413 || status === 422) {
    return new SyncError('rejected', 'rejected', { cause })
  }
  if (status === 401) {
    // Only reached after a refresh succeeded and the new token was refused as well.
    return new SyncError('paused', 'token-refused', { cause })
  }
  if (status === 403) {
    return new SyncError('paused', 'not-permitted', { cause })
  }
  if (status === 404) {
    return new SyncError('paused', 'sync-off', { cause })
  }
  return new SyncError('paused', 'server-error', { cause })
}

const isNamed = (error: unknown, name: string) =>
  typeof error === 'object' && error !== null && 'name' in error && (error as { name: unknown }).name === name

/** Put any failure into one of the {@link SyncFailureKind}s. */
export const classifyError = (error: unknown): SyncError => {
  if (error instanceof SyncError) {
    return error
  }
  if (error instanceof InvalidGrantError) {
    return new SyncError('reauth', 'signed-out', { cause: error })
  }
  if (error instanceof HttpError) {
    return fromStatus(error.response, error)
  }
  if (isNamed(error, 'TimeoutError')) {
    return new SyncError('transient', 'timeout', { cause: error })
  }
  if (error instanceof TypeError) {
    // fetch rejects with a TypeError when the network is down or the connection drops.
    return new SyncError('transient', 'offline', { cause: error })
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return new SyncError('paused', 'unreadable', { cause: error })
  }
  return new SyncError('transient', 'unknown', { cause: error })
}

const baseDelayMs = 1000
const minDelayMs = 500
const maxDelayMs: Record<SyncFailureKind, number> = {
  transient: 60_000,
  paused: 300_000,
  rejected: 300_000,
  reauth: 300_000,
}

/**
 * How long to wait before retry number `attempt` (1 for the first): exponential with full jitter,
 * capped by the failure's kind, and never sooner than the server's Retry-After, which is itself held
 * to that cap (a huge value would overflow `setTimeout` and fire at once).
 */
export const backoffDelay = (attempt: number, error: SyncError, random: () => number = Math.random): number => {
  const cap = maxDelayMs[error.kind]
  const ceiling = Math.min(cap, baseDelayMs * 2 ** Math.max(0, attempt - 1))
  const jittered = Math.max(minDelayMs, Math.floor(random() * ceiling))
  return Math.max(jittered, Math.min(error.retryAfterMs ?? 0, cap))
}
