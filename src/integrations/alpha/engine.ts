/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  deleteChatThreadIfEmpty,
  getOrCreateChatThread,
  getSelectedModel,
  restoreChatMessages,
  saveChatMessagesWithParents,
  softDeleteChatMessages,
  updateChatThread,
} from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { ThunderboltUIMessage } from '@/types'
import { backoffDelay, classifyError, SyncError, type SyncErrorCode } from './errors'
import { uuidv7Iso } from './ids'
import { readMessages, readOutboundCandidates, readThreadMessages, readThreads } from './local-reads'
import { placeOnLocalThread, pushLimits } from './map'
import {
  applyMapWrites,
  batchSize,
  chunkBatch,
  isSkippedEvent,
  localRejections,
  mapWritesForAck,
  planInbound,
  planOutbound,
  rejectedEntries,
  removeMapEntries,
  splitBatch,
  type ChunkLimits,
  type IdMap,
  type InboundPlan,
  type LocalMessage,
  type MapEntry,
} from './plan'
import type { ExternalSyncProvider, InboundBatch, InboundMessage, OutboundBatch, PushAck } from './provider'
import { deleteMapEntries, deleteMeta, getMeta, loadIdMap, metaKeys, saveMapEntries, setMeta } from './storage'

/*
 * The provider-agnostic half of the bridge. It owns the id map, reads and writes Thunderbolt's rows,
 * and runs two loops with separate status:
 * - pull holds the provider's change stream open, applies each batch and reconnects from the saved
 *   cursor, with backoff on failure;
 * - push runs when the chat tables change, reads only the rows that may need syncing, and sends
 *   them in batches that fit the remote's limits.
 * Pull and push never interleave: each plans against what the other already wrote.
 */

export type LoopState = 'idle' | 'ok' | 'retrying' | 'paused' | 'signed-out'

export type LoopStatus = {
  state: LoopState
  error: SyncErrorCode | null
  /** Epoch ms of the next attempt while retrying or paused. */
  nextRetryAt: number | null
  lastOkAt: number | null
}

export type EngineStatus = {
  pull: LoopStatus
  push: LoopStatus
  /** Rows recorded as not synced (refused by the remote, or past its limits). */
  notSynced: number
}

export type EngineControls = {
  /** Forget the remote's refusals so those rows are sent again, then try now. */
  retryRejected: () => Promise<void>
}

type EngineOptions = {
  db: AnyDrizzleDatabase
  provider: ExternalSyncProvider
  /**
   * Smallest local id that may be uploaded as a new thread (see `planOutbound`). A function is called
   * once this device's chat rows have loaded, since a window another device shares arrives with them.
   */
  syncFrom: string | (() => Promise<string>)
  onStatus: (status: EngineStatus) => void
  /** Called once when the remote refuses the refresh token; the engine stops afterwards. */
  onSignedOut?: () => Promise<void>
  onControls?: (controls: EngineControls) => void
  /**
   * Called after an inbound batch is written, with the local chats it wrote messages into, or `all`
   * when it deleted messages (a delete names rows, not their chats). A chat already open keeps its
   * messages in memory, so this is how it learns to read them again. Never awaited; a throw is ignored.
   */
  onInboundApplied?: (threads: InboundTouched) => void
  /** How long a finished assistant message must stay unchanged before it is pushed. */
  settleMs?: number
  /**
   * How long an assistant message that still looks unfinished (see `LocalMessage.isStreaming`) must
   * stay unchanged before it is pushed as it stands. A reply stopped or failed mid-stream keeps its
   * parts unfinished for good; without this bound it would hold its thread forever.
   */
  stalledMs?: number
  /** The first push waits for the first pulled batch, or this long. */
  firstPushDelayMs?: number
  /**
   * Resolves once this device holds the chat rows its own sync service has for it. Both loops wait
   * for it: a pull before then can't confirm rows other devices pushed, and a push can't see which
   * rows another device already adopted. If it fails, the engine stops with a `local-data` error
   * rather than sync without the rows.
   */
  waitForLocalData?: (signal: AbortSignal) => Promise<void>
  /** Most unsynced messages read in one pass. */
  candidateLimit?: number
  /** What the remote may add here in a day before the pull pauses; see {@link inboundDailyBudget}. */
  inboundBudget?: InboundBudget
  chunkLimits?: ChunkLimits
  now?: () => number
  random?: () => number
}

/** Under the push route's limits ({@link pushLimits}), with room for the envelope. */
export const defaultChunkLimits: ChunkLimits = {
  threads: Math.floor(pushLimits.conversations * 0.75),
  messages: Math.floor(pushLimits.messages * 0.8),
  bytes: Math.floor(pushLimits.bodyBytes * 0.75),
}

/**
 * Most pushes one pass lets the remote refuse outright while it splits batches to find the rows it
 * refuses: enough to find a few bad rows in a full chunk, far fewer than the 2N - 1 a remote that
 * refuses every push would otherwise cost. Past it the pass stops and the push loop backs off; rows
 * not yet placed are sent again then.
 */
const maxRefusedPushes = 24

/** What one push pass may still spend on refusals, and the refusal of a row it holds back, if any. */
type PushBudget = { refusals: number; held: SyncError | null }

/** A stream that ends this soon without a single event is treated as a failure, not a routine close. */
const minHealthyStreamMs = 10_000
/** After the remote asks for rows to be sent again later. */
const retryLaterMs = 5000

const idleStatus = (): LoopStatus => ({ state: 'idle', error: null, nextRetryAt: null, lastOkAt: null })

/** A timer that a wake or an abort ends early. A wake with nobody waiting ends the next wait at once. */
const createWaker = () => {
  let current: (() => void) | null = null
  let pending = false
  return {
    wake: () => {
      if (current) {
        current()
      } else {
        pending = true
      }
    },
    /** Forget a wake that arrived while nobody waited. */
    clear: () => {
      pending = false
    },
    wait: (ms: number, signal: AbortSignal): Promise<void> => {
      if (pending || signal.aborted) {
        pending = false
        return Promise.resolve()
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', done)
          current = null
          resolve()
        }
        const timer = Number.isFinite(ms) ? setTimeout(done, Math.max(0, ms)) : undefined
        signal.addEventListener('abort', done, { once: true })
        current = done
      })
    },
  }
}

const toUiMessage = (m: InboundMessage): ThunderboltUIMessage => ({
  id: m.localId,
  role: m.role,
  parts: [{ type: 'text', text: m.text }],
  metadata: m.metadata,
})

const recordMapWrites = async (db: AnyDrizzleDatabase, map: IdMap, writes: MapEntry[]) => {
  await saveMapEntries(db, writes)
  applyMapWrites(map, writes)
}

/**
 * The local rows one inbound batch can touch: its own ids, whatever the map ties them to, and every
 * message in the threads it names (to place inserts, find rows another device already wrote, and
 * tell the person's own messages from the remote's).
 */
const readInboundSnapshot = async (db: AnyDrizzleDatabase, map: IdMap, batch: InboundBatch) => {
  const threadIds: string[] = []
  const messageIds: string[] = []
  for (const thread of batch.threads) {
    const threadId = map.threadsByRemote.get(thread.remoteId)?.localId ?? thread.localId
    threadIds.push(thread.localId, threadId)
    messageIds.push(...(map.messagesByThread.get(threadId) ?? []))
    for (const message of thread.messages) {
      messageIds.push(message.localId, map.messagesByRemote.get(message.remoteId)?.localId ?? message.localId)
    }
  }
  for (const tombstone of batch.tombstones) {
    const entry = (tombstone.kind === 'thread' ? map.threadsByRemote : map.messagesByRemote).get(tombstone.remoteId)
    if (entry) {
      ;(tombstone.kind === 'thread' ? threadIds : messageIds).push(entry.localId)
    }
  }
  const byId = new Map<string, LocalMessage>()
  for (const m of [...(await readMessages(db, messageIds)), ...(await readThreadMessages(db, threadIds))]) {
    byId.set(m.id, m)
  }
  return { threads: await readThreads(db, threadIds), messages: [...byId.values()] }
}

type InboundOptions = Parameters<typeof planInbound>[3]

/**
 * Plan one inbound batch against the local rows it can touch, each conversation's messages placed on
 * the chat the map ties it to.
 */
export const planInboundFromDb = async (
  db: AnyDrizzleDatabase,
  map: IdMap,
  batch: InboundBatch,
  options: InboundOptions,
): Promise<InboundPlan> => {
  const threads = await Promise.all(
    batch.threads.map((thread) => {
      const known = map.threadsByRemote.get(thread.remoteId)
      return known ? placeOnLocalThread(thread, known.localId) : thread
    }),
  )
  const placed = { ...batch, threads }
  return planInbound(placed, map, await readInboundSnapshot(db, map, placed), options)
}

/**
 * Carry out an inbound plan: the DAL writes, then the map entries. A plan that fails partway leaves
 * the map as it was, so the batch's replay (its cursor is saved only after this) plans it in full
 * again. The caller runs this where no push pass can interleave, so the writes are never pushed back.
 */
export const writeInbound = async (db: AnyDrizzleDatabase, map: IdMap, plan: InboundPlan): Promise<void> => {
  const dropMarkers = new Map(
    plan.dropMessages.map(({ localId, conversationId, messageId }) => [
      localId,
      { alpha: { conversationId, messageId, dropped: true } },
    ]),
  )
  await softDeleteChatMessages(db, plan.deleteMessages, dropMarkers)
  if (plan.createThreads.length) {
    // A thread row needs a model; the person's current pick is what Thunderbolt would use for a reply.
    const model = await getSelectedModel(db).catch((error: unknown) => {
      throw new SyncError('paused', 'no-model', { cause: error })
    })
    for (const thread of plan.createThreads) {
      await getOrCreateChatThread(db, thread.localId, model.id, { isEncrypted: 0 })
      await updateChatThread(db, thread.localId, { title: thread.title })
    }
  }
  for (const thread of plan.renameThreads) {
    await updateChatThread(db, thread.localId, { title: thread.title })
  }
  for (const { threadLocalId, messages } of plan.restoreMessages) {
    await restoreChatMessages(
      db,
      threadLocalId,
      messages.map((m) => ({ message: toUiMessage(m), parentId: m.parentId })),
    )
  }
  for (const { threadLocalId, messages } of plan.insertMessages) {
    await saveChatMessagesWithParents(
      db,
      threadLocalId,
      messages.map((m) => ({ message: toUiMessage(m), parentId: m.parentId })),
    )
  }
  for (const { threadLocalId, messages } of plan.updateMessages) {
    // Existing rows: only their mutable columns change, so the parent given here is never used.
    await saveChatMessagesWithParents(
      db,
      threadLocalId,
      messages.map((m) => ({ message: toUiMessage(m), parentId: null })),
    )
  }
  for (const id of plan.deleteThreads) {
    await deleteChatThreadIfEmpty(db, id)
  }
  await recordMapWrites(db, map, plan.mapWrites)
}

/** Apply one inbound batch. Returns the plan it applied. */
export const applyInbound = async (
  db: AnyDrizzleDatabase,
  map: IdMap,
  batch: InboundBatch,
  options: InboundOptions,
): Promise<InboundPlan> => {
  const plan = await planInboundFromDb(db, map, batch, options)
  await writeInbound(db, map, plan)
  return plan
}

/** The local chats whose messages an applied plan changed; `all` when it deleted messages. */
export type InboundTouched = string[] | 'all'

/** What an applied plan changed for an open chat, or null when it changed no message. */
export const inboundTouched = (plan: InboundPlan): InboundTouched | null => {
  if (plan.deleteMessages.length) {
    return 'all'
  }
  const ids = new Set(
    [...plan.insertMessages, ...plan.restoreMessages, ...plan.updateMessages]
      .filter((group) => group.messages.length)
      .map((group) => group.threadLocalId),
  )
  return ids.size ? [...ids] : null
}

/**
 * What one device takes in from the remote in a day. Each change event is bounded, but nothing bounds
 * how many the remote sends, and every chat, message, rewrite and rename it writes here is stored,
 * uploaded by Thunderbolt's own sync to the person's account and shown. Once a day's use reaches any
 * of these, a batch that would write more waits for the next day (the pull pauses, its cursor
 * unmoved); deletes still apply. The batch that crosses a limit lands whole, so no single event can
 * stall the stream. Room enough for a first sync of a long history.
 */
export const inboundDailyBudget = { chats: 2_000, messages: 50_000, chars: 100_000_000 }
export type InboundBudget = typeof inboundDailyBudget

const dayMs = 86_400_000

/** What the remote wrote here since `since` (epoch ms), the start of the current day's window. */
type InboundUse = { since: number; chats: number; messages: number; chars: number }

/**
 * The rows and characters an inbound plan writes. A rewrite of an existing message stores and
 * uploads its whole new text again, and a rename its whole title, so both count in full. A record
 * of a skipped conversation is a row the remote's data adds here too, so it counts as a chat.
 */
const inboundGrowth = (plan: InboundPlan): Omit<InboundUse, 'since'> => {
  const added = [...plan.insertMessages, ...plan.restoreMessages].flatMap((group) => group.messages)
  const rewritten = plan.updateMessages.flatMap((group) => group.messages)
  const titled = [...plan.createThreads, ...plan.renameThreads]
  return {
    chats: plan.createThreads.length + plan.skipRecords,
    messages: added.length,
    chars:
      [...added, ...rewritten].reduce((sum, m) => sum + m.text.length, 0) +
      titled.reduce((sum, t) => sum + t.title.length, 0),
  }
}

/** The current window's use, or a fresh window when there is none, it has ended, or it can't be read. */
const readInboundUse = async (db: AnyDrizzleDatabase, at: number): Promise<InboundUse> => {
  const fresh = { since: at, chats: 0, messages: 0, chars: 0 }
  let stored: unknown
  try {
    stored = JSON.parse((await getMeta(db, metaKeys.inboundUse)) ?? 'null')
  } catch {
    return fresh
  }
  const use = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<keyof InboundUse, unknown>
  const counts = [use.since, use.chats, use.messages, use.chars]
  if (!counts.every((n): n is number => typeof n === 'number' && Number.isFinite(n))) {
    return fresh
  }
  const [since, chats, messages, chars] = counts
  return at < since || at - since >= dayMs ? fresh : { since, chats, messages, chars }
}

/**
 * Apply one inbound batch within the day's budget: a batch that writes anything but deletes once the
 * budget is spent throws a `paused` error and changes nothing. Returns the plan it applied.
 */
export const applyInboundWithinBudget = async (
  db: AnyDrizzleDatabase,
  map: IdMap,
  batch: InboundBatch,
  options: InboundOptions,
  { budget, at }: { budget: InboundBudget; at: number },
): Promise<InboundPlan> => {
  const plan = await planInboundFromDb(db, map, batch, options)
  const growth = inboundGrowth(plan)
  const grows = growth.chats > 0 || growth.messages > 0 || growth.chars > 0
  const use = await readInboundUse(db, at)
  if (grows && (use.chats >= budget.chats || use.messages >= budget.messages || use.chars >= budget.chars)) {
    throw new SyncError('paused', 'inbound-limit')
  }
  await writeInbound(db, map, plan)
  if (grows) {
    await setMeta(
      db,
      metaKeys.inboundUse,
      JSON.stringify({
        since: use.since,
        chats: use.chats + growth.chats,
        messages: use.messages + growth.messages,
        chars: use.chars + growth.chars,
      }),
    )
  }
  return plan
}

/**
 * Only a batch's tombstones, which never add anything. While the pull waits on the day's budget it
 * applies these from the held batch and every later one, so a chat deleted on the remote meanwhile
 * goes here too; the whole batch replays from the saved cursor once the budget allows.
 */
const deletesOnly = (batch: InboundBatch): InboundBatch => ({
  cursor: batch.cursor,
  threads: [],
  tombstones: batch.tombstones,
})

const isInboundLimit = (error: unknown) => error instanceof SyncError && error.code === 'inbound-limit'

/**
 * Run the bridge until `signal` aborts or the remote signs this device out. `subscribe` reports
 * local changes to the chat tables (PowerSync's `onChange` in the app) and returns its unsubscribe.
 */
export const runSyncEngine = async (
  {
    db,
    provider,
    syncFrom: syncFromOption,
    onStatus,
    onSignedOut,
    onControls,
    onInboundApplied,
    settleMs = 4000,
    stalledMs = 60_000,
    firstPushDelayMs = 5000,
    waitForLocalData,
    candidateLimit = 1000,
    inboundBudget = inboundDailyBudget,
    chunkLimits = defaultChunkLimits,
    now = Date.now,
    random = Math.random,
  }: EngineOptions,
  subscribe: (onChange: () => void) => () => void,
  signal: AbortSignal,
): Promise<void> => {
  const map = await loadIdMap(db)
  const status: EngineStatus = { pull: idleStatus(), push: idleStatus(), notSynced: rejectedEntries(map).length }
  const emit = () => onStatus({ pull: { ...status.pull }, push: { ...status.push }, notSynced: status.notSynced })
  const setLoop = (loop: 'pull' | 'push', next: Partial<LoopStatus>) => {
    status[loop] = { ...status[loop], ...next }
    status.notSynced = rejectedEntries(map).length
    emit()
  }

  const pullWaker = createWaker()
  const pushWaker = createWaker()
  /** Set once this device's chat rows have loaded, before either loop starts. */
  let syncFrom = ''
  /** The change stream now open; Retry ends it to read skipped events again. */
  let stream: AbortController | null = null
  let stopped = false
  let gateOpen = false
  let dirty = true
  let pushBackingOff = false

  const tellOpenChats = (plan: InboundPlan) => {
    const touched = onInboundApplied ? inboundTouched(plan) : null
    if (!touched) {
      return
    }
    try {
      onInboundApplied?.(touched)
    } catch {
      // Refreshing a chat on screen is the app's concern; the batch is already written.
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  const signOut = async () => {
    if (stopped) {
      return
    }
    stopped = true
    await onSignedOut?.().catch((error: unknown) => console.error('AI Potluck sign-out cleanup failed', error))
    const signedOut = { state: 'signed-out' as const, error: 'signed-out' as const, nextRetryAt: null }
    setLoop('pull', signedOut)
    setLoop('push', signedOut)
    pullWaker.wake()
    pushWaker.wake()
  }

  // Assistant replies are pushed once they stop changing: after settleMs when finished, after
  // stalledMs when they still look unfinished. `seen` remembers when each last changed.
  const seen = new Map<string, { text: string; since: number }>()
  const isSettled = (m: LocalMessage) => {
    if (m.role !== 'assistant') {
      return true
    }
    const prior = seen.get(m.id)
    if (!prior || prior.text !== m.text) {
      seen.set(m.id, { text: m.text, since: now() })
      return false
    }
    return now() - prior.since >= (m.isStreaming ? stalledMs : settleMs)
  }
  /** Unchanged for the stall window. Called after `isSettled`, which records when it last changed. */
  const isStalled = (m: LocalMessage) => {
    const prior = seen.get(m.id)
    return prior !== undefined && prior.text === m.text && now() - prior.since >= stalledMs
  }

  const withThreadRemoteIds = (batch: OutboundBatch): OutboundBatch => ({
    threads: batch.threads,
    messages: batch.messages.map((m) =>
      m.threadRemoteId || !m.threadLocalId
        ? m
        : { ...m, threadRemoteId: map.threads.get(m.threadLocalId)?.remoteId ?? null },
    ),
  })

  /**
   * Push one chunk; a refused body is split until the refused row is found and recorded, within the
   * pass's budget of refused pushes. A refused delete or rename is not recorded but held (see below).
   */
  const pushChunk = async (chunk: OutboundBatch, budget: PushBudget): Promise<boolean> => {
    const batch = withThreadRemoteIds(chunk)
    let ack: PushAck
    try {
      ack = await provider.push(batch, signal)
    } catch (error) {
      const failure = classifyError(error)
      if (failure.kind !== 'rejected') {
        throw failure
      }
      budget.refusals += 1
      if (budget.refusals > maxRefusedPushes) {
        throw failure
      }
      if (batchSize(batch) > 1) {
        const [first, second] = splitBatch(batch)
        const firstRetry = await pushChunk(first, budget)
        return (await pushChunk(second, budget)) || firstRetry
      }
      // One row is left, but a refused body does not prove the row is bad: the server may refuse
      // every body (a stricter schema after a deploy, a proxy). A new row is recorded as refused, and
      // Retry sends it again. A delete or rename of a row the remote has is the person's change, and
      // recording it would end it for good, so it stays unsent and the pass backs off; it goes again
      // after the backoff, or on Retry.
      const changesRemoteRow = batch.threads.some((t) => t.remoteId) || batch.messages.some((m) => m.remoteId)
      if (changesRemoteRow) {
        budget.held = failure
        return false
      }
      ack = {
        threads: [],
        messages: [],
        rejected: [
          ...batch.threads.map((t) => ({ kind: 'thread' as const, localId: t.localId, reason: 'invalid' })),
          ...batch.messages.map((m) => ({ kind: 'message' as const, localId: m.localId, reason: 'invalid' })),
        ],
      }
    }
    const { mapWrites, retryLater } = mapWritesForAck(batch, ack, map)
    await recordMapWrites(db, map, mapWrites)
    batch.messages.forEach((m) => seen.delete(m.localId))
    return retryLater
  }

  const pushPass = async () => {
    const candidates = await readOutboundCandidates(db, { syncFrom, limit: candidateLimit })
    const plan = planOutbound(candidates, map, {
      isSettled,
      isStalled,
      createdAt: uuidv7Iso,
      syncFrom,
      maxContentChars: pushLimits.contentChars,
    })
    await recordMapWrites(db, map, plan.mapWrites)
    let retryLater = false
    const budget: PushBudget = { refusals: 0, held: null }
    for (const chunk of chunkBatch(plan.batch, chunkLimits)) {
      retryLater = (await pushChunk(chunk, budget)) || retryLater
    }
    if (budget.held) {
      // Back off as for any refusal; the held rows are still unsent, so the next pass reads them.
      throw budget.held
    }
    const candidateIds = new Set(candidates.messages.map((m) => m.id))
    for (const id of seen.keys()) {
      if (!candidateIds.has(id)) {
        seen.delete(id)
      }
    }
    const progressed = plan.mapWrites.length > 0 || batchSize(plan.batch) > 0
    return { hasMore: candidates.hasMore && progressed, isHolding: plan.isHolding, retryLater }
  }

  const pushLoop = async () => {
    await pushWaker.wait(firstPushDelayMs, signal)
    gateOpen = true
    let attempt = 0
    while (!signal.aborted && !stopped) {
      if (!dirty) {
        await pushWaker.wait(Infinity, signal)
        continue
      }
      dirty = false
      let nextMs: number | null
      try {
        const result = await serial(pushPass)
        attempt = 0
        setLoop('push', { state: 'ok', error: null, nextRetryAt: null, lastOkAt: now() })
        nextMs = result.hasMore ? 0 : result.retryLater ? retryLaterMs : result.isHolding ? settleMs : null
      } catch (error) {
        if (signal.aborted) {
          break
        }
        const failure = classifyError(error)
        if (failure.kind === 'reauth') {
          await signOut()
          break
        }
        attempt += 1
        nextMs = backoffDelay(attempt, failure, random)
        setLoop('push', {
          state: failure.kind === 'transient' ? 'retrying' : 'paused',
          error: failure.code,
          nextRetryAt: now() + nextMs,
        })
        pushBackingOff = true
        pushWaker.clear()
      }
      if (nextMs !== null) {
        dirty = true
        await pushWaker.wait(nextMs, signal)
        pushBackingOff = false
      }
    }
  }

  const pullLoop = async () => {
    let attempt = 0
    while (!signal.aborted && !stopped) {
      const openedAt = now()
      let received = false
      const current = new AbortController()
      stream = current
      /** Set once a batch waits on the day's budget; later batches then apply only their deletes. */
      let held = false
      try {
        let cursor = await getMeta(db, metaKeys.cursor)
        for await (const batch of provider.changes(cursor, AbortSignal.any([signal, current.signal]))) {
          const applied = await serial(async () => {
            if (current.signal.aborted) {
              return false
            }
            let skippedEvent = false
            let plan: InboundPlan | null = null
            if (!held) {
              try {
                plan = await applyInboundWithinBudget(
                  db,
                  map,
                  batch,
                  { syncFrom },
                  { budget: inboundBudget, at: now() },
                )
                skippedEvent = plan.skippedEvent
              } catch (error) {
                if (!isInboundLimit(error)) {
                  throw error
                }
                held = true
              }
            }
            if (held) {
              // The cursor stays before the held batch, so it and everything after it replay later.
              tellOpenChats(await applyInbound(db, map, deletesOnly(batch), { syncFrom }))
              return 'held'
            }
            // A skipped event can't be read here; Retry reads the stream again from just before the
            // first one, so its changes are not lost for good.
            if (plan) {
              tellOpenChats(plan)
            }
            if (skippedEvent && (await getMeta(db, metaKeys.replayFrom)) === null) {
              await setMeta(db, metaKeys.replayFrom, cursor ?? '')
            }
            if (batch.cursor !== null) {
              await setMeta(db, metaKeys.cursor, batch.cursor)
              cursor = batch.cursor
            }
            return true
          })
          if (!applied) {
            break
          }
          received = true
          if (applied === 'held') {
            setLoop('pull', { state: 'paused', error: 'inbound-limit', nextRetryAt: null })
            continue
          }
          attempt = 0
          setLoop('pull', { state: 'ok', error: null, nextRetryAt: null, lastOkAt: now() })
          if (!gateOpen) {
            pushWaker.wake()
          }
        }
        if (current.signal.aborted) {
          continue
        }
        if (held) {
          // Back off before reading the held batch again, as for any pause.
          throw new SyncError('paused', 'inbound-limit')
        }
        if (!received && now() - openedAt < minHealthyStreamMs) {
          throw new SyncError('transient', 'stream-ended')
        }
        // The remote closes the stream every few minutes by design; reopen from the cursor, spread
        // out so many clients don't reconnect in the same instant.
        await pullWaker.wait(250 + Math.floor(random() * 1750), signal)
      } catch (error) {
        if (signal.aborted) {
          break
        }
        if (current.signal.aborted) {
          continue
        }
        const failure = classifyError(error)
        if (failure.kind === 'reauth') {
          await signOut()
          break
        }
        attempt += 1
        const pacing = failure.kind === 'rejected' ? new SyncError('paused', failure.code) : failure
        const delay = backoffDelay(attempt, pacing, random)
        setLoop('pull', {
          state: failure.kind === 'transient' ? 'retrying' : 'paused',
          error: failure.code,
          nextRetryAt: now() + delay,
        })
        pullWaker.clear()
        await pullWaker.wait(delay, signal)
      }
    }
  }

  const wake = () => {
    dirty = true
    pullWaker.wake()
    pushWaker.wake()
  }
  onControls?.({
    retryRejected: () =>
      serial(async () => {
        const replayFrom = await getMeta(db, metaKeys.replayFrom)
        const entries = rejectedEntries(map).filter(
          (e) => !localRejections.has(e.rejected as string) || (replayFrom !== null && isSkippedEvent(e)),
        )
        if (replayFrom !== null) {
          // Read the stream again from just before the first skipped event; its records clear now
          // and come back only if it still can't be read.
          await (replayFrom ? setMeta(db, metaKeys.cursor, replayFrom) : deleteMeta(db, [metaKeys.cursor]))
          await deleteMeta(db, [metaKeys.replayFrom])
          stream?.abort()
        }
        await deleteMapEntries(db, entries)
        removeMapEntries(map, entries)
        status.notSynced = rejectedEntries(map).length
        emit()
      }).then(wake),
  })

  const unsubscribe = subscribe(() => {
    dirty = true
    if (gateOpen && !pushBackingOff) {
      pushWaker.wake()
    }
  })
  emit()
  try {
    try {
      await waitForLocalData?.(signal)
    } catch (error) {
      if (signal.aborted) {
        return
      }
      throw new SyncError('paused', 'local-data', { cause: error })
    }
    syncFrom = typeof syncFromOption === 'string' ? syncFromOption : await syncFromOption()
    await Promise.all([pullLoop(), pushLoop()])
  } finally {
    unsubscribe()
  }
}
