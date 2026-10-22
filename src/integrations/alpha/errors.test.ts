/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { InvalidGrantError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { z } from 'zod'
import { HttpError } from '@/lib/http'
import { backoffDelay, classifyError, parseRetryAfter, SyncError } from './errors'

const httpError = (status: number, headers: Record<string, string> = {}) =>
  new HttpError(new Response(null, { status, headers }))

describe('classifyError', () => {
  it('stops only when the refresh token is refused', () => {
    expect(classifyError(new InvalidGrantError('revoked'))).toMatchObject({ kind: 'reauth', code: 'signed-out' })
    // Every other failure keeps the bridge running, including a refresh the server failed to answer.
    for (const error of [
      new ServerError('down'),
      httpError(500),
      httpError(401),
      httpError(403),
      httpError(404),
      new TypeError('Failed to fetch'),
      new DOMException('timed out', 'TimeoutError'),
      new Error('anything'),
    ]) {
      expect(classifyError(error).kind).not.toBe('reauth')
    }
  })

  it('retries soon on network trouble, timeouts, 5xx and 429, honouring Retry-After', () => {
    expect(classifyError(new TypeError('Failed to fetch'))).toMatchObject({ kind: 'transient', code: 'offline' })
    expect(classifyError(new DOMException('slow', 'TimeoutError'))).toMatchObject({
      kind: 'transient',
      code: 'timeout',
    })
    expect(classifyError(httpError(503))).toMatchObject({ kind: 'transient', code: 'server-error' })
    expect(classifyError(httpError(429, { 'Retry-After': '30' }))).toMatchObject({
      kind: 'transient',
      code: 'rate-limited',
      retryAfterMs: 30_000,
    })
  })

  it('pauses on answers retrying soon cannot fix, and marks a refused body as rejected', () => {
    expect(classifyError(httpError(403))).toMatchObject({ kind: 'paused', code: 'not-permitted' })
    expect(classifyError(httpError(404))).toMatchObject({ kind: 'paused', code: 'sync-off' })
    expect(classifyError(httpError(401))).toMatchObject({ kind: 'paused', code: 'token-refused' })
    expect(classifyError(httpError(413))).toMatchObject({ kind: 'rejected' })
    expect(classifyError(httpError(400))).toMatchObject({ kind: 'rejected' })
    expect(classifyError(z.object({ v: z.literal(1) }).safeParse({}).error)).toMatchObject({
      kind: 'paused',
      code: 'unreadable',
    })
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and ignores garbage', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000)
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
  })
})

describe('backoffDelay', () => {
  const transient = new SyncError('transient', 'offline')

  it('grows exponentially under a ceiling, with full jitter', () => {
    expect(backoffDelay(1, transient, () => 1)).toBe(1000)
    expect(backoffDelay(4, transient, () => 1)).toBe(8000)
    expect(backoffDelay(30, transient, () => 1)).toBe(60_000)
    expect(backoffDelay(30, new SyncError('paused', 'sync-off'), () => 1)).toBe(300_000)
    expect(backoffDelay(4, transient, () => 0.5)).toBe(4000)
  })

  it('never retries in a tight loop, even when the jitter draws zero', () => {
    expect(backoffDelay(1, transient, () => 0)).toBe(500)
  })

  it('never retries before the server’s Retry-After', () => {
    const limited = new SyncError('transient', 'rate-limited', { retryAfterMs: 45_000 })
    expect(backoffDelay(1, limited, () => 1)).toBe(45_000)
  })

  it('holds a huge Retry-After to the kind’s ceiling, so it cannot overflow setTimeout into a tight loop', () => {
    const huge = new SyncError('transient', 'rate-limited', { retryAfterMs: parseRetryAfter('99999999') })
    expect(backoffDelay(1, huge, () => 0)).toBe(60_000)
  })
})
