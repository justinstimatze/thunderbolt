/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { getClock } from '@/testing-library'
import { SyncError } from './errors'
import { readServerSentEvents } from './sse'

const encoder = new TextEncoder()

/** A body that sends `chunks`, then either ends or stays open without sending anything. */
const body = (chunks: string[], { staysOpen = false } = {}) => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(encoder.encode(c)))
      if (!staysOpen) {
        controller.close()
      }
    },
    cancel() {
      cancelled = true
    },
  })
  return { stream, isCancelled: () => cancelled }
}

const collect = async (stream: ReadableStream<Uint8Array>, options = { idleMs: 1000, maxEventChars: 1000 }) => {
  const items: string[] = []
  for await (const item of readServerSentEvents(stream, options)) {
    items.push(item.type === 'event' ? `${item.event.event}:${item.event.data}` : `too-large:${item.id}`)
  }
  return items
}

describe('readServerSentEvents', () => {
  it('yields events split across chunks and skips heartbeat comments', async () => {
    const { stream } = body([': heartbeat\n\n', 'event: changes\nda', 'ta: {"a":1}\n\n'])
    expect(await collect(stream)).toEqual(['changes:{"a":1}'])
  })

  it('gives up on a connection that goes quiet, and cancels the body', async () => {
    const { stream, isCancelled } = body(['event: changes\ndata: 1\n\n'], { staysOpen: true })
    const pending = collect(stream, { idleMs: 50, maxEventChars: 1000 }).catch((e: unknown) => e)
    await getClock().tickAsync(60)
    const error = await pending
    expect(error).toBeInstanceOf(SyncError)
    expect(error).toMatchObject({ kind: 'transient', code: 'stream-stalled' })
    expect(isCancelled()).toBe(true)
  })

  it('drops an event that grows past the size cap, never yielding its data, reports its id, and reads the next event', async () => {
    const { stream, isCancelled } = body([
      'id: c1\nevent: changes\ndata: ',
      'x'.repeat(600),
      'x'.repeat(600),
      'x'.repeat(600),
      '\n\nid: c2\nevent: changes\ndata: ok\n\n',
    ])
    expect(await collect(stream, { idleMs: 1000, maxEventChars: 1000 })).toEqual(['too-large:c1', 'changes:ok'])
    expect(isCancelled()).toBe(false)
  })

  it('counts toward the size cap the characters that follow an event boundary in the same chunk', async () => {
    const { stream } = body([
      'id: c1\nevent: changes\ndata: small\n\nid: c2\nevent: changes\ndata: ' + 'x'.repeat(600),
      'x'.repeat(600) + '\n\n',
    ])
    expect(await collect(stream, { idleMs: 1000, maxEventChars: 1000 })).toEqual(['changes:small', 'too-large:c2'])
  })

  it('reads events whose lines end in CRLF split across chunks', async () => {
    const { stream } = body(['id: c1\r', '\nevent: changes\r\ndata: 1\r\n\r', '\nid: c2\r\ndata: 2\r\n\r\n'])
    expect(await collect(stream)).toEqual(['changes:1', 'undefined:2'])
  })

  it('cancels the body when the reader stops early', async () => {
    const { stream, isCancelled } = body(['event: changes\ndata: 1\n\n', 'event: changes\ndata: 2\n\n'], {
      staysOpen: true,
    })
    for await (const item of readServerSentEvents(stream, { idleMs: 1000, maxEventChars: 1000 })) {
      expect(item.type).toBe('event')
      break
    }
    expect(isCancelled()).toBe(true)
  })
})
