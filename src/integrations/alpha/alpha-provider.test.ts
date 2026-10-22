/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import { createAlphaProvider, maxPushResponseBytes, pushDeadlineMs, readJson } from './alpha-provider'
import type { AlphaConfig } from './config'
import { classifyError } from './errors'
import type { OutboundBatch } from './provider'
import { saveAlphaConnection } from './storage'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const config: AlphaConfig = { origin: 'https://alpha.example', clientId: 'thunderbolt-test' }
const realFetch = globalThis.fetch

beforeEach(async () => {
  await resetTestDatabase()
  await saveAlphaConnection(getDb(), {
    origin: config.origin,
    metadata: {
      issuer: config.origin,
      authorization_endpoint: `${config.origin}/authorize`,
      token_endpoint: `${config.origin}/token`,
      response_types_supported: ['code'],
    } as AuthorizationServerMetadata,
    credentials: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null },
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const encoder = new TextEncoder()

/** A body that sends `chunks` and then stays open, sending nothing more, until cancelled. */
const openBody = (chunks: string[]) => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(encoder.encode(c)))
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, isCancelled: () => cancelled }
}

const emptyPush: OutboundBatch = { threads: [], messages: [] }

describe('push', () => {
  it('gives up on an answer whose body never finishes once the push deadline passes, as a retryable timeout', async () => {
    const { stream, isCancelled } = openBody(['{"v":1,'])
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch
    const provider = createAlphaProvider({ db: getDb(), config })
    const pushing = provider.push(emptyPush, new AbortController().signal).catch((e: unknown) => e)
    await getClock().tickAsync(pushDeadlineMs + 10)
    const error = await pushing
    expect(classifyError(error)).toMatchObject({ kind: 'transient', code: 'timeout' })
    expect(isCancelled()).toBe(true)
  })
})

describe('push limits', () => {
  it('refuses a body past the server’s limits without sending it, as a rejection the engine splits', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const provider = createAlphaProvider({ db: getDb(), config })
    const message = {
      localId: 'm',
      remoteId: null,
      threadLocalId: 't',
      threadRemoteId: 'conv',
      role: 'user' as const,
      text: 'x',
      createdAt: 'x',
      deletedAt: null,
    }
    const tooMany: OutboundBatch = { threads: [], messages: Array.from({ length: 1001 }, () => message) }
    const error = await provider.push(tooMany, new AbortController().signal).catch((e: unknown) => e)
    expect(classifyError(error)).toMatchObject({ kind: 'rejected' })
    expect(requests).toBe(0)
  })
})

describe('changes', () => {
  it('moves past one change event too large to read, recording it as skipped, and reads the next', async () => {
    const next = JSON.stringify({ v: 1, cursor: 'c2', conversations: [], tombstones: [] })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('id: c1\nevent: changes\ndata: '))
        controller.enqueue(encoder.encode('x'.repeat(8_000_001)))
        controller.enqueue(encoder.encode(`\n\nid: c2\nevent: changes\ndata: ${next}\n\n`))
        controller.close()
      },
    })
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch
    const provider = createAlphaProvider({ db: getDb(), config })
    const batches = []
    for await (const batch of provider.changes(null, new AbortController().signal)) {
      batches.push(batch)
    }
    expect(batches).toEqual([
      { cursor: 'c1', threads: [], tombstones: [], skipped: [{ remoteId: null, reason: 'too-large' }] },
      { cursor: 'c2', threads: [], tombstones: [] },
    ])
  })

  it('moves past change events it cannot read or that pass the size cap without an id, recording each as skipped', async () => {
    const next = JSON.stringify({ v: 1, cursor: 'c3', conversations: [], tombstones: [] })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: changes\ndata: {"v": 2}\n\n'))
        controller.enqueue(encoder.encode('id: c1\nevent: changes\ndata: not json\n\n'))
        controller.enqueue(encoder.encode(`event: changes\ndata: ${'x'.repeat(8_000_001)}\n\n`))
        controller.enqueue(encoder.encode(`id: c3\nevent: changes\ndata: ${next}\n\n`))
        controller.close()
      },
    })
    globalThis.fetch = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch
    const provider = createAlphaProvider({ db: getDb(), config })
    const batches = []
    for await (const batch of provider.changes(null, new AbortController().signal)) {
      batches.push(batch)
    }
    // An event with no id of its own keeps the position the stream last gave.
    expect(batches).toEqual([
      { cursor: null, threads: [], tombstones: [], skipped: [{ remoteId: null, reason: 'unreadable' }] },
      { cursor: 'c1', threads: [], tombstones: [], skipped: [{ remoteId: null, reason: 'unreadable' }] },
      { cursor: 'c1', threads: [], tombstones: [], skipped: [{ remoteId: null, reason: 'too-large' }] },
      { cursor: 'c3', threads: [], tombstones: [] },
    ])
  })
})

describe('readJson', () => {
  it('refuses an answer larger than the cap without reading all of it', async () => {
    const { stream, isCancelled } = openBody(['x'.repeat(600), 'x'.repeat(600)])
    const error = await readJson(new Response(stream), new AbortController().signal, 1000).catch((e: unknown) => e)
    expect(classifyError(error)).toMatchObject({ kind: 'paused', code: 'unreadable' })
    expect(isCancelled()).toBe(true)
    expect(maxPushResponseBytes).toBeGreaterThan(1000)
  })

  it('reads an answer that arrives in pieces', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":'))
        controller.enqueue(encoder.encode('1}'))
        controller.close()
      },
    })
    expect(await readJson(new Response(stream), new AbortController().signal, 1000)).toEqual({ a: 1 })
  })
})
