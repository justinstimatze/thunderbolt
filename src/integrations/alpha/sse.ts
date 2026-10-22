/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { SyncError } from './errors'

type ReadOptions = {
  /** Give up when nothing (not even a heartbeat comment) arrives for this long. */
  idleMs: number
  /** Give up when one event grows past this many characters. */
  maxEventChars: number
}

const readWithin = async <T>(read: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SyncError('transient', 'stream-stalled')), ms)
  })
  try {
    return await Promise.race([read, stalled])
  } finally {
    clearTimeout(timer)
  }
}

/** What the reader yields: an event, or the id of an event dropped for passing the size cap. */
export type ServerSentItem = { type: 'event'; event: EventSourceMessage } | { type: 'too-large'; id: string | null }

const lineEnd = /\r\n|\r|\n/g
/** Only the start of a line is kept, enough to read an `id:` field. */
const keptLineChars = 1100

/**
 * Server-sent events from a fetch body (`EventSource` cannot send a bearer token), with two guards
 * a long-lived stream needs: an idle watchdog, since a connection can die without closing, and a
 * cap on one event's size, since the parser buffers an event until it ends.
 *
 * The cap counts every character since the last blank line (an event ends at one), across chunk
 * boundaries. An event past it is dropped without being buffered: the parser is reset, the rest of
 * the event is skipped up to its blank line, and a `too-large` item carries the event's `id:`
 * field, so the caller can move past it. The body is cancelled whenever reading stops.
 */
export const readServerSentEvents = async function* (
  body: ReadableStream<Uint8Array>,
  { idleMs, maxEventChars }: ReadOptions,
): AsyncGenerator<ServerSentItem> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const ready: ServerSentItem[] = []
  const parser = createParser({ onEvent: (event) => ready.push({ type: 'event', event }) })
  let sinceBoundary = 0
  let dropping = false
  /** The current line so far (its start only), and the current event's `id:` field. */
  let line = ''
  let eventId: string | null = null
  /** The previous chunk ended in `\r`, so a leading `\n` belongs to that line ending. */
  let afterCr = false

  const endLine = () => {
    if (line === '') {
      if (dropping) {
        ready.push({ type: 'too-large', id: eventId })
        dropping = false
      }
      eventId = null
      sinceBoundary = 0
    } else if (line.startsWith('id:')) {
      const value = line.slice(3)
      eventId = value.startsWith(' ') ? value.slice(1) : value
    }
    line = ''
  }

  /** One piece of text that holds at most one line ending, at its end. */
  const take = (piece: string, endsLine: boolean) => {
    if (!dropping) {
      parser.feed(piece)
    }
    sinceBoundary += piece.length
    if (line.length < keptLineChars) {
      line += piece.slice(0, keptLineChars - line.length).replace(/[\r\n]+$/, '')
    }
    if (endsLine) {
      endLine()
    }
    if (!dropping && sinceBoundary > maxEventChars) {
      dropping = true
      parser.reset()
    }
  }

  try {
    while (true) {
      const { done, value } = await readWithin(reader.read(), idleMs)
      if (done) {
        return
      }
      let text = decoder.decode(value, { stream: true })
      if (afterCr && text.startsWith('\n')) {
        if (!dropping) {
          parser.feed('\n')
        }
        text = text.slice(1)
      }
      afterCr = false
      let from = 0
      for (const match of text.matchAll(lineEnd)) {
        const to = match.index + match[0].length
        if (match[0] === '\r' && to === text.length) {
          afterCr = true
        }
        take(text.slice(from, to), true)
        from = to
      }
      if (from < text.length) {
        take(text.slice(from), false)
      }
      while (ready.length) {
        yield ready.shift() as ServerSentItem
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}
