/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { textHash, uuidv7At, uuidv7Ms } from './ids'
import type {
  InboundBatch,
  InboundMessage,
  InboundSkip,
  InboundThread,
  InboundTombstone,
  OutboundBatch,
  PushAck,
} from './provider'

/*
 * AI Potluck's conversation sync wire format, v1 (`v: 1` in every body, served on its
 * `/chat/api/v2/sync/*` routes), and its mapping onto Thunderbolt's rows. The wire shape is AI
 * Potluck's own; Thunderbolt's schema stays on this side.
 *
 * Two things in Thunderbolt's schema decide the mapping:
 * - Neither chat_threads nor chat_messages has a created-at column; both sort by id, a UUIDv7 whose
 *   first 48 bits are milliseconds. A row written in AI Potluck gets a UUIDv7 minted from wire data
 *   only (its createdAt, the other bits hashed from AI Potluck's id), never from this device's
 *   clock, so every device maps the same row to the same id.
 * - A message renders from `parts`; `content` is only the search copy. AI Potluck's own fields ride
 *   in metadata under `alpha`.
 */

/**
 * The server's push limits. A batch is cut to fit them (see `chunkBatch` in plan.ts), and a body past
 * them is refused before it is sent (see {@link fitsPushLimits}).
 */
export const pushLimits = {
  bodyBytes: 2_000_000,
  conversations: 200,
  messages: 1000,
  contentChars: 100_000,
  titleChars: 200,
  idChars: 200,
} as const

/**
 * Bounds on what one inbound event may carry. A conversation past them is skipped and recorded as
 * not synced, and the rest of the event applies. An event listing more than `conversations` is
 * skipped whole and recorded once, since each conversation it names could otherwise leave a record.
 */
export const inboundLimits = {
  conversations: 500,
  messagesPerConversation: 5000,
  tombstones: 5000,
  /** Longer texts are cut here rather than refused, so one long message can't wedge the stream. */
  contentChars: 200_000,
  titleChars: 500,
  /** Longer runs of whitespace are cut here; see {@link renderSafe}. */
  whitespaceRun: 100,
} as const

const id = z.string().min(1).max(pushLimits.idChars)
const clipped = (max: number) => z.string().transform((s) => (s.length > max ? s.slice(0, max) : s))

export const messageV1Schema = z.object({
  id,
  clientId: z.string().max(pushLimits.idChars).nullable(),
  role: z.enum(['user', 'assistant', 'system']),
  content: clipped(inboundLimits.contentChars),
  createdAt: z.string().max(64),
  origin: z.string().max(pushLimits.idChars),
  model: z.string().max(pushLimits.idChars).optional(),
})

export const conversationV1Schema = z.object({
  id,
  clientId: z.string().max(pushLimits.idChars).nullable(),
  title: clipped(inboundLimits.titleChars),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  origin: z.string().max(pushLimits.idChars).optional(),
  messages: z.array(messageV1Schema).max(inboundLimits.messagesPerConversation),
})

export const tombstoneV1Schema = z.object({
  kind: z.enum(['conversation', 'message']),
  id,
  clientId: z.string().max(pushLimits.idChars).nullable(),
  origin: z.string().max(pushLimits.idChars).optional(),
  deletedAt: z.string().max(64),
})

export const changesEventV1Schema = z.object({
  v: z.literal(1),
  cursor: z.string().max(1000),
  conversations: z.array(conversationV1Schema).max(inboundLimits.conversations),
  tombstones: z.array(tombstoneV1Schema).max(inboundLimits.tombstones),
})

/**
 * The parts of an event that must be readable for any of it to apply. Each conversation and
 * tombstone is then read on its own, so one bad row can't hold back the rest or the cursor.
 */
const changesEnvelopeV1Schema = z.object({
  v: z.literal(1),
  cursor: z.string().max(1000),
  conversations: z.array(z.unknown()),
  tombstones: z.array(z.unknown()),
})

/** Just enough of a conversation to say which one was skipped. */
const conversationIdV1Schema = z.object({ id })

const ackSchema = z.object({ clientId: z.string(), id: z.string() })

export const pushResponseV1Schema = z.object({
  v: z.literal(1),
  conversations: z.array(ackSchema),
  messages: z.array(ackSchema),
  rejected: z
    .array(
      z.object({
        kind: z.enum(['conversation', 'message']),
        clientId: z.string(),
        id: z.string().nullable().optional(),
        reason: z.string().max(100),
      }),
    )
    .default([]),
})

export type MessageV1 = z.infer<typeof messageV1Schema>
export type ConversationV1 = z.infer<typeof conversationV1Schema>
export type ChangesEventV1 = z.input<typeof changesEventV1Schema>

export type PushBodyV1 = {
  v: 1
  conversations: {
    id: string | null
    clientId: string
    title: string
    createdAt: string
    deletedAt: string | null
  }[]
  messages: {
    id: string | null
    clientId: string
    conversationClientId: string | null
    conversationId: string | null
    role: 'user' | 'assistant'
    content: string
    createdAt: string
    deletedAt: string | null
  }[]
}

/**
 * How far ahead of this device's clock a wire time may be. Ids are minted from wire times as given,
 * so devices whose clocks disagree still agree on ids; only a time this far ahead is refused, so
 * the bound matters only to a server or device whose clock is off by a day. A refused message is
 * listed as unplaced, never treated as gone, so a slow clock never deletes a synced copy.
 */
export const maxFutureMs = 24 * 60 * 60 * 1000

/** A time from the wire, in ms, or null when it is unreadable or more than {@link maxFutureMs} ahead. */
const wireMs = (iso: string, now: number): number | null => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) || ms > now + maxFutureMs ? null : ms
}

const threadSeed = (conversationId: string) => `alpha-thread:${conversationId}`

/**
 * The seed of a message id. AI Potluck's chat export uses `alpha-message:<conversation>:<message>`,
 * and the two must agree, so that form is kept for ids without a colon (all AI Potluck mints). It
 * is ambiguous once an id holds one (`a:b` + `c` and `a` + `b:c`), so such pairs are seeded from an
 * unambiguous encoding under a prefix the plain form can never produce.
 */
export const messageSeed = (conversationId: string, messageId: string) =>
  conversationId.includes(':') || messageId.includes(':')
    ? `alpha-message-json:${JSON.stringify([conversationId, messageId])}`
    : `alpha-message:${conversationId}:${messageId}`

/**
 * The local thread id for an AI Potluck conversation that no Thunderbolt device pushed, or null when
 * its createdAt can't be used: such a conversation is skipped, never minted from this device's clock.
 */
export const mintThreadId = async (
  conversation: Pick<ConversationV1, 'id' | 'createdAt'>,
  now = Date.now(),
): Promise<string | null> => {
  const ms = wireMs(conversation.createdAt, now)
  return ms === null ? null : uuidv7At(ms, threadSeed(conversation.id))
}

/**
 * True when `threadId` is the id {@link mintThreadId} gives conversation `conversationId`: the thread
 * was created from AI Potluck. A thread started in Thunderbolt has a random id that no conversation
 * id can reproduce, whatever dates AI Potluck sends.
 */
export const isMintedThreadId = async (threadId: string, conversationId: string): Promise<boolean> => {
  const ms = uuidv7Ms(threadId)
  return ms !== null && uuidv7At(ms, threadSeed(conversationId)) === threadId.toLowerCase()
}

/**
 * Local ids for a conversation's messages, keyed by AI Potluck's id. They rise in the order AI
 * Potluck lists them, even where two share a millisecond, or Thunderbolt would show an answer above
 * its question. None sorts before `floorMs`, the time in the thread's own id, so AI Potluck can't
 * date a message to before the chat began. A message whose createdAt can't be used gets no id and is
 * skipped.
 */
export const mintMessageIds = async (
  conversation: { id: string; messages: Pick<MessageV1, 'id' | 'createdAt'>[] },
  floorMs: number,
  now = Date.now(),
): Promise<Map<string, string>> => {
  let last = floorMs - 1
  const ids = new Map<string, string>()
  for (const m of conversation.messages) {
    const ms = wireMs(m.createdAt, now)
    if (ms === null) {
      continue
    }
    last = Math.max(last + 1, ms)
    ids.set(m.id, uuidv7At(last, messageSeed(conversation.id, m.id)))
  }
  return ids
}

/**
 * `thread` placed on the local chat `threadLocalId`. The id map can tie a conversation to a chat
 * other than the one its message ids were minted on (AI Potluck re-sending it under another client
 * id or an earlier date). When that chat began later, the minted ids are minted again with its start
 * as the floor, so no turn sorts before the chat began. A claimed id is kept: it is accepted only
 * once confirmed against the local rows.
 */
export const placeOnLocalThread = async (
  thread: InboundThread,
  threadLocalId: string,
  now = Date.now(),
): Promise<InboundThread> => {
  const floorMs = uuidv7Ms(threadLocalId)
  const mintedFromMs = uuidv7Ms(thread.localId)
  if (floorMs === null || (mintedFromMs !== null && mintedFromMs >= floorMs)) {
    return thread
  }
  const messages = thread.messages.map((m) => ({ id: m.remoteId, createdAt: m.createdAt }))
  const ids = await mintMessageIds({ id: thread.remoteId, messages }, floorMs, now)
  return {
    ...thread,
    messages: thread.messages.map((m) => (m.isEcho ? m : { ...m, localId: ids.get(m.remoteId) ?? m.localId })),
  }
}

/**
 * The local id a row claims this app gave it, when the claim is well formed: a UUIDv7 no more than
 * {@link maxFutureMs} ahead, the same tolerance as minting, so another device's clock running ahead
 * of this one never turns its own row into a copy. Whether this device actually holds that row is
 * checked later, against the local tables.
 */
const plausibleClaim = (clientId: string | null, now: number): string | null => {
  const ms = clientId ? uuidv7Ms(clientId) : null
  return ms !== null && ms <= now + maxFutureMs ? clientId : null
}

/*
 * Text from AI Potluck is made safe for Thunderbolt's message renderer before it is stored, since
 * it may quote a web page. The renderer (`parseContentParts` in widget-parser.ts) deletes citation
 * marks (`【1】`, `【1†title】`), then turns `<namespace:name …/>` into live UI (a connect prompt, a
 * link preview that fetches a URL), and hides an unfinished `<widget:…` at the end. Its patterns
 * backtrack, so text built for them can also hold the tab for minutes, every time the chat opens.
 * Everything here is a scan whose cost is linear on every engine.
 *
 * - Every `<` that opens a namespaced tag (`<ns:name` and then whitespace) is escaped to `&lt;`,
 *   which shows as the same character, whether or not a `/>` closes it. A closed one would render
 *   as UI; an open one costs the renderer a pass over the rest of the text, and `<widget:` then
 *   whitespace costs it one per character. The check runs on the text as the parser sees it, with
 *   citation marks deleted, so `<【1】widget:` is caught too. The cost: in a code block `&lt;` is not
 *   decoded, so namespaced XML there (`<xsl:template …>`) shows `&lt;`. Any other `<` is left alone.
 * - An unfinished `<widget:name` at the end is escaped too, so it stays visible.
 * - A whitespace run is cut to {@link inboundLimits}`.whitespaceRun` characters: the parser's
 *   citation patterns start with `\s*`, which JavaScriptCore (Safari, the desktop app) retries from
 *   every character of a run.
 * - A `【N†` with no `】` after it can never be a citation mark, but the parser scans to the end of
 *   the text from each one. A word joiner (U+2060, invisible) after its `【` stops that scan at once.
 *
 * - Every `![` gets a word joiner between its two characters, so markdown reads `![alt](url)` as a
 *   link to `url` (through `SafeLink`, opened only by a click) instead of an image the browser
 *   fetches as soon as the chat renders, which would tell the sender when it was read and from
 *   where. An image with no alt text shows nothing. In a code block the joiner is invisible but is
 *   copied with the text.
 *
 * Beyond that, this guards the widget parser only. The markdown after it is linear in Thunderbolt's own passes
 * (`rewriteMath` in markdown-blocks.ts); remark-gfm's autolink-literal pass is not, and costs about
 * a second on 200k characters of one dense paragraph.
 */

/** A text and, for each of its characters, the index it had in the original (null: the same). */
type View = { text: string; origin: number[] | null }

const space = /\s/
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const wordJoiner = '\u2060'

/** Cut every whitespace run longer than {@link inboundLimits}`.whitespaceRun`. */
const cutWhitespaceRuns = (text: string): string => {
  let out = ''
  let from = 0
  let run = 0
  for (let i = 0; i < text.length; i++) {
    run = space.test(text[i]) ? run + 1 : 0
    if (run > inboundLimits.whitespaceRun) {
      out += text.slice(from, i)
      from = i + 1
    }
  }
  return out + text.slice(from)
}

/** Put a word joiner after every `【` of a `【N†` that no `】` follows. */
const breakUnclosedCitations = (text: string): string => {
  const lastClose = text.lastIndexOf('】')
  let out = ''
  let from = 0
  for (let open = text.indexOf('【', lastClose + 1); open !== -1; open = text.indexOf('【', open + 1)) {
    let end = open + 1
    while (isDigit(text[end])) {
      end++
    }
    if (end > open + 1 && text[end] === '†') {
      out += text.slice(from, open + 1) + wordJoiner
      from = open + 1
    }
  }
  return out + text.slice(from)
}

/**
 * `view` with one of the parser's two citation patterns deleted: `\s*【N†…】` when `titled`, else
 * `\s*【N】`. Each match starts where the regex's would, at the whitespace before its `【`, and never
 * inside the previous match, so the result is what the parser's `replace` gives.
 */
const deleteCitations = (view: View, titled: boolean): View => {
  const { text, origin } = view
  if (!text.includes('【')) {
    return view
  }
  let out = ''
  const kept: number[] = []
  let from = 0
  /** The first `】` after the last one looked for, or Infinity once there is none. */
  let close = -1
  const keep = (to: number) => {
    out += text.slice(from, to)
    for (let i = from; i < to; i++) {
      kept.push(origin ? origin[i] : i)
    }
  }
  for (let open = text.indexOf('【'); open !== -1; open = text.indexOf('【', open + 1)) {
    let end = open + 1
    while (isDigit(text[end])) {
      end++
    }
    if (end === open + 1) {
      continue
    }
    if (titled) {
      if (text[end] !== '†') {
        continue
      }
      if (close <= end) {
        const found = text.indexOf('】', end + 1)
        close = found === -1 ? Infinity : found
      }
      if (close === Infinity) {
        continue
      }
      end = close + 1
    } else if (text[end] === '】') {
      end += 1
    } else {
      continue
    }
    let start = open
    while (start > from && space.test(text[start - 1])) {
      start--
    }
    keep(start)
    from = end
    open = end - 1
  }
  keep(text.length)
  return { text: out, origin: kept }
}

/** At `lastIndex`: a `<` that opens a namespaced tag, as widget-parser's tag patterns begin. */
const tagOpener = /<[a-z][a-z0-9-]*:[a-z0-9-]*\s/iy
/** What follows the last `<` when it is the unfinished tag `parseContentParts` hides. */
const unfinishedTag = /^<widget:[a-z0-9-]*$/i

/** Escape every `<` that opens a namespaced tag once citation marks are deleted, and an unfinished one at the end. */
export const inertWidgets = (text: string): string => {
  if (!text.includes('<')) {
    return text
  }
  const view = deleteCitations(deleteCitations({ text, origin: null }, true), false)
  const originOf = (i: number) => (view.origin ? view.origin[i] : i)
  const escape = new Set<number>()
  for (let i = view.text.indexOf('<'); i !== -1; i = view.text.indexOf('<', i + 1)) {
    tagOpener.lastIndex = i
    if (tagOpener.test(view.text)) {
      escape.add(originOf(i))
    }
  }
  const tail = view.text.trimEnd()
  const last = tail.lastIndexOf('<')
  if (last !== -1 && unfinishedTag.test(tail.slice(last))) {
    escape.add(originOf(last))
  }
  let out = ''
  let from = 0
  for (const at of escape) {
    out += `${text.slice(from, at)}&lt;`
    from = at + 1
  }
  return out + text.slice(from)
}

/** Put a word joiner between the `!` and `[` of every `![`, so markdown reads a link, never an image. */
const unlinkImages = (text: string): string => text.replaceAll('![', `!${wordJoiner}[`)

/** Text from AI Potluck as it is stored here: safe to hand to Thunderbolt's renderer (see above). */
export const renderSafe = (text: string): string =>
  inertWidgets(unlinkImages(breakUnclosedCitations(cutWhitespaceRuns(text))))

type MapContext = {
  /** The OAuth client id: rows AI Potluck says this client pushed claim a local id. */
  clientId: string
  now?: number
}

/** Why a conversation that failed its schema was skipped. */
const skipReason = (error: z.ZodError): InboundSkip['reason'] =>
  error.issues.some((issue) => issue.code === 'too_big' && issue.path.length === 1 && issue.path[0] === 'messages')
    ? 'too-large'
    : 'unreadable'

/**
 * One `changes` event in Thunderbolt-shaped rows. System messages are dropped: AI Potluck's system
 * prompt is its own, and in Thunderbolt it would steer this device's model.
 *
 * Only the envelope (`v`, `cursor`, the two arrays) must be readable. A conversation that fails its
 * schema or passes a limit is listed in `skipped` and the rest still applies, so one oversized or
 * malformed conversation never stops the stream at its cursor. An event listing more than
 * `inboundLimits.conversations` applies none of them and is recorded as skipped. An unreadable
 * tombstone is dropped; tombstones past the first `inboundLimits.tombstones` are dropped and the
 * event recorded as skipped.
 */
export const toInbound = async (raw: unknown, ctx: MapContext): Promise<InboundBatch> => {
  const event = changesEnvelopeV1Schema.parse(raw)
  const now = ctx.now ?? Date.now()
  const claim = (row: { origin?: string; clientId: string | null }) =>
    row.origin === ctx.clientId ? plausibleClaim(row.clientId, now) : null

  const threads: InboundThread[] = []
  const skipped: InboundSkip[] = []
  const tooMany = event.conversations.length > inboundLimits.conversations
  if (tooMany) {
    skipped.push({ remoteId: null, reason: 'too-many' })
  }
  for (const rawConversation of tooMany ? [] : event.conversations) {
    const parsed = conversationV1Schema.safeParse(rawConversation)
    if (!parsed.success) {
      const named = conversationIdV1Schema.safeParse(rawConversation)
      skipped.push({ remoteId: named.success ? named.data.id : null, reason: skipReason(parsed.error) })
      continue
    }
    const c = parsed.data
    const threadClaim = claim(c)
    const threadId = threadClaim ?? (await mintThreadId(c, now))
    if (threadId === null) {
      continue
    }
    const messages = c.messages.filter(
      (m): m is MessageV1 & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant',
    )
    const minted = await mintMessageIds({ id: c.id, messages }, uuidv7Ms(threadId) as number, now)
    const inbound: InboundMessage[] = []
    const unplaced: string[] = []
    for (const m of messages) {
      const messageClaim = claim(m)
      const localId = messageClaim ?? minted.get(m.id)
      if (localId === undefined) {
        unplaced.push(m.id)
        continue
      }
      const text = renderSafe(m.content)
      inbound.push({
        remoteId: m.id,
        localId,
        isEcho: messageClaim !== null,
        role: m.role,
        text,
        createdAt: m.createdAt,
        metadata: {
          alpha: {
            conversationId: c.id,
            messageId: m.id,
            origin: m.origin,
            createdAt: m.createdAt,
            ...(m.model ? { model: m.model } : {}),
            textHash: textHash(text),
          },
        },
      })
    }
    threads.push({
      remoteId: c.id,
      localId: threadId,
      isEcho: threadClaim !== null,
      title: c.title,
      messages: inbound,
      ...(unplaced.length ? { unplaced } : {}),
    })
  }
  if (event.tombstones.length > inboundLimits.tombstones) {
    skipped.push({ remoteId: null, reason: 'too-many' })
  }
  const tombstones: InboundTombstone[] = []
  for (const rawTombstone of event.tombstones.slice(0, inboundLimits.tombstones)) {
    const parsed = tombstoneV1Schema.safeParse(rawTombstone)
    if (parsed.success) {
      const t = parsed.data
      tombstones.push({
        kind: t.kind === 'conversation' ? 'thread' : 'message',
        remoteId: t.id,
        deletedAt: t.deletedAt,
      })
    }
  }
  return { cursor: event.cursor, threads, tombstones, ...(skipped.length ? { skipped } : {}) }
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

/** Whether a push body is within the server's limits on conversations, messages and size. */
export const fitsPushLimits = (body: PushBodyV1): boolean =>
  body.conversations.length <= pushLimits.conversations &&
  body.messages.length <= pushLimits.messages &&
  new TextEncoder().encode(JSON.stringify(body)).length <= pushLimits.bodyBytes

/** An outbound batch as a v1 push body. */
export const toPushBody = (batch: OutboundBatch): PushBodyV1 => ({
  v: 1,
  conversations: batch.threads.map((t) => ({
    id: t.remoteId,
    clientId: t.localId,
    title: clip(t.title ?? '', pushLimits.titleChars),
    createdAt: t.createdAt,
    deletedAt: t.deletedAt,
  })),
  messages: batch.messages.map((m) => ({
    id: m.remoteId,
    clientId: m.localId,
    // Name the conversation by AI Potluck's id when known; a thread pushed in this same batch is
    // named by its client id instead.
    conversationId: m.threadRemoteId,
    conversationClientId: m.threadRemoteId ? null : m.threadLocalId,
    role: m.role,
    content: m.text,
    createdAt: m.createdAt,
    deletedAt: m.deletedAt,
  })),
})

/** The push response as acknowledgements and rejections keyed by local id. */
export const fromPushResponse = (body: unknown): PushAck => {
  const parsed = pushResponseV1Schema.parse(body)
  return {
    threads: parsed.conversations.map((c) => ({ localId: c.clientId, remoteId: c.id })),
    messages: parsed.messages.map((m) => ({ localId: m.clientId, remoteId: m.id })),
    rejected: parsed.rejected.map((r) => ({
      kind: r.kind === 'conversation' ? 'thread' : 'message',
      localId: r.clientId,
      reason: r.reason,
    })),
  }
}
