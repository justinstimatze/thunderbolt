/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZodError } from 'zod'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { HttpError, http } from '@/lib/http'
import { alphaProviderId, type AlphaConfig } from './config'
import { getFreshConnection } from './connect'
import { SyncError } from './errors'
import { fitsPushLimits, fromPushResponse, toInbound, toPushBody } from './map'
import type { ExternalSyncProvider, InboundBatch, SkipReason } from './provider'
import { readServerSentEvents } from './sse'
import type { AlphaConnection } from './storage'

/**
 * The sync routes. They speak wire format v1 (`v: 1` in every body) under AI Potluck's v2 chat API.
 * OAuth endpoints come from discovery; these have no discovery document.
 */
const changesPath = '/chat/api/v2/sync/changes'
const pushPath = '/chat/api/v2/sync/push'

/** The server sends a heartbeat comment every 2 s; this much silence means the connection is gone. */
const streamIdleMs = 20_000
/** Longest single change event accepted, in characters. */
const maxEventChars = 8_000_000
/** How long the change stream may take to answer with its headers. */
const requestTimeoutMs = 30_000
/** How long a whole push may take, its answer's body included. */
export const pushDeadlineMs = 30_000
/** Largest push answer read, in bytes. An answer lists at most one short line per pushed row. */
export const maxPushResponseBytes = 4_000_000

/**
 * A response body as JSON, read within `signal` and refused past `maxBytes`. A fetch body stops on
 * abort by itself; the race covers a body that does not.
 */
export const readJson = async (response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> => {
  if (!response.body) {
    throw new SyncError('paused', 'unreadable')
  }
  const reader = response.body.getReader()
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) {
      fail()
    } else {
      signal.addEventListener('abort', fail, { once: true })
    }
  })
  aborted.catch(() => undefined)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted])
      if (done) {
        break
      }
      size += value.byteLength
      if (size > maxBytes) {
        throw new SyncError('paused', 'unreadable')
      }
      chunks.push(value)
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

type AlphaProviderOptions = {
  db: AnyDrizzleDatabase
  config: AlphaConfig
}

/**
 * The AI Potluck provider: the change stream and the push route, both wire format v1. Every request
 * reads the stored tokens afresh, so a refresh made for one request is seen by the next. A 401
 * refreshes once and retries; a second 401 is reported, not retried here.
 */
export const createAlphaProvider = ({ db, config }: AlphaProviderOptions): ExternalSyncProvider => {
  const send = async (make: (c: AlphaConnection) => Promise<Response>): Promise<Response> => {
    const connection = await getFreshConnection(db, config)
    try {
      return await make(connection)
    } catch (error) {
      if (!(error instanceof HttpError) || error.response.status !== 401) {
        throw error
      }
      const refreshed = await getFreshConnection(db, config, { refused: connection.credentials.accessToken })
      return make(refreshed)
    }
  }

  const authorization = (c: AlphaConnection) => `Bearer ${c.credentials.accessToken}`

  /** One change event's batch, or null when its body is not JSON or not wire format v1. */
  const readChanges = async (data: string): Promise<InboundBatch | null> => {
    try {
      return await toInbound(JSON.parse(data), { clientId: config.clientId })
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError) {
        return null
      }
      throw error
    }
  }

  const changes = async function* (cursor: string | null, signal: AbortSignal): AsyncGenerator<InboundBatch> {
    const response = await send((c) =>
      http.get(`${c.origin}${changesPath}`, {
        headers: { Authorization: authorization(c), Accept: 'text/event-stream' },
        searchParams: cursor ? { cursor } : undefined,
        signal,
        timeout: requestTimeoutMs,
      }),
    )
    if (!response.body) {
      throw new SyncError('transient', 'stream-ended')
    }
    // An event's SSE id is its cursor. One with no id keeps the position the stream last gave.
    let position = cursor
    /**
     * Record an event this device can't apply and move past it, so one bad page doesn't stop every
     * later change from arriving.
     */
    const skip = (id: string | null | undefined, reason: SkipReason): InboundBatch => {
      position = id || position
      return { cursor: position, threads: [], tombstones: [], skipped: [{ remoteId: null, reason }] }
    }
    for await (const item of readServerSentEvents(response.body, { idleMs: streamIdleMs, maxEventChars })) {
      if (item.type === 'too-large') {
        yield skip(item.id, 'too-large')
        continue
      }
      if (item.event.event !== 'changes') {
        continue
      }
      const batch = await readChanges(item.event.data)
      if (batch === null) {
        yield skip(item.event.id, 'unreadable')
        continue
      }
      position = batch.cursor
      yield batch
    }
  }

  return {
    id: alphaProviderId,
    changes,
    push: async (batch, signal) => {
      const body = toPushBody(batch)
      if (!fitsPushLimits(body)) {
        // Refused here the way the server would refuse it, so the engine splits the batch.
        throw new SyncError('rejected', 'rejected')
      }
      // One deadline for the whole push. The request's own timeout ends when the headers arrive,
      // and a body that never finishes would otherwise hold up every later push and pull.
      const deadline = new AbortController()
      const timer = setTimeout(
        () => deadline.abort(new DOMException('AI Potluck push timed out', 'TimeoutError')),
        pushDeadlineMs,
      )
      const bounded = AbortSignal.any([signal, deadline.signal])
      try {
        const response = await send((c) =>
          http.post(`${c.origin}${pushPath}`, {
            headers: { Authorization: authorization(c) },
            json: body,
            signal: bounded,
          }),
        )
        return fromPushResponse(await readJson(response, bounded, maxPushResponseBytes))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
