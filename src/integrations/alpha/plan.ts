/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { textHash } from './ids'
import type { InboundBatch, InboundMessage, OutboundBatch, OutboundMessage, OutboundThread, PushAck } from './provider'

/*
 * The engine's decisions, as pure functions over plain data, so echo suppression and the id map can
 * be tested without a database. `engine.ts` reads the local rows, calls these, and applies the
 * result through the DAL.
 *
 * Echo suppression has two parts:
 * - The id map: a row gets its map entry in the same serialized step as the engine's local write
 *   of it, before any push pass can read, so the local change that write triggers finds it mapped
 *   and never pushes it back; and a pushed row returns from the remote carrying this app's id, which
 *   is already mapped.
 * - Provenance: a message written from the remote carries `metadata.alpha`, which syncs with it. A
 *   device that receives such a row through Thunderbolt's own sync (and so has no map entry for it)
 *   adopts it into its map instead of pushing it.
 */

export type MapEntry = {
  kind: 'thread' | 'message'
  localId: string
  remoteId: string | null
  /** 'remote': the row came from the provider. 'local': it was written in Thunderbolt. */
  source: 'remote' | 'local'
  /** Threads: the title both sides last agreed on. */
  title?: string | null
  /**
   * Threads: the last few titles the remote sent, newest last. A local title equal to one of them
   * was written from the remote (possibly by another device, delivered late), not by the person,
   * so it is never pushed back as a rename.
   */
  remoteTitles?: string[]
  /** Messages: the thread it belongs to (a soft-deleted message loses its own link). */
  threadLocalId?: string | null
  deleted?: boolean
  /**
   * Messages: soft-deleted here because the row left the remote's live branch (a regeneration
   * there), not because the person deleted it. Unlike `deleted`, the row is brought back if it
   * returns to the branch.
   */
  dropped?: boolean
  /** Messages: fingerprint of the text both sides last agreed on. */
  hash?: string
  /** Why the row does not sync: the remote's reason, or one of {@link localRejections}. */
  rejected?: string
}

export type IdMap = {
  threads: Map<string, MapEntry>
  messages: Map<string, MapEntry>
  threadsByRemote: Map<string, MapEntry>
  messagesByRemote: Map<string, MapEntry>
  /** Message local ids by the local id of their thread. */
  messagesByThread: Map<string, Set<string>>
}

export const emptyIdMap = (): IdMap => ({
  threads: new Map(),
  messages: new Map(),
  threadsByRemote: new Map(),
  messagesByRemote: new Map(),
  messagesByThread: new Map(),
})

const unindex = (map: IdMap, entry: MapEntry) => {
  const byRemote = entry.kind === 'thread' ? map.threadsByRemote : map.messagesByRemote
  if (entry.remoteId && byRemote.get(entry.remoteId) === entry) {
    byRemote.delete(entry.remoteId)
  }
  if (entry.kind === 'message' && entry.threadLocalId) {
    map.messagesByThread.get(entry.threadLocalId)?.delete(entry.localId)
  }
}

/** Apply map writes to the in-memory map and its indexes. */
export const applyMapWrites = (map: IdMap, writes: MapEntry[]): void => {
  for (const entry of writes) {
    const entries = entry.kind === 'thread' ? map.threads : map.messages
    const previous = entries.get(entry.localId)
    if (previous) {
      unindex(map, previous)
    }
    entries.set(entry.localId, entry)
    if (entry.remoteId) {
      ;(entry.kind === 'thread' ? map.threadsByRemote : map.messagesByRemote).set(entry.remoteId, entry)
    }
    if (entry.kind === 'message' && entry.threadLocalId) {
      const ids = map.messagesByThread.get(entry.threadLocalId) ?? new Set<string>()
      ids.add(entry.localId)
      map.messagesByThread.set(entry.threadLocalId, ids)
    }
  }
}

/** Drop entries from the in-memory map, so their rows are considered again. */
export const removeMapEntries = (map: IdMap, entries: MapEntry[]): void => {
  for (const entry of entries) {
    const current = (entry.kind === 'thread' ? map.threads : map.messages).get(entry.localId)
    if (current) {
      unindex(map, current)
      ;(entry.kind === 'thread' ? map.threads : map.messages).delete(entry.localId)
    }
  }
}

/**
 * Rejections decided on this device, for rows it would not push and remote conversations it could
 * not apply. Retrying can't change them, so Retry leaves them alone.
 */
export const localRejections = new Set(['empty', 'too-large', 'too-many', 'unreadable', 'unsupported-role'])

/** How many recent remote titles a thread's map entry remembers. */
const rememberedTitles = 5

const withRemoteTitle = (titles: string[] | undefined, title: string): string[] =>
  titles?.at(-1) === title ? titles : [...(titles ?? []).filter((t) => t !== title), title].slice(-rememberedTitles)

/** The map key that records a remote conversation, or a whole event, this device skipped. */
const skippedKey = (remoteId: string | null, cursor: string | null) =>
  remoteId === null ? `skipped-event:${cursor ?? 'start'}` : `skipped:${remoteId}`

/**
 * A record of something skipped that names no conversation. Nothing that arrives later can clear it;
 * Retry does, by reading the stream again from before it.
 */
export const isSkippedEvent = (entry: MapEntry) => entry.localId.startsWith('skipped-event:')

/** A record of a skipped conversation or event (see {@link skippedKey}), not a mapped row. */
const isSkipRecord = (entry: MapEntry) => entry.localId.startsWith('skipped:') || isSkippedEvent(entry)

/**
 * Most skip records the map holds, cleared ones included. Each is a row the remote's data adds
 * here, loaded at every start; past this many a skip is not recorded on its own, and the event it
 * came in is read again on Retry instead (see {@link InboundPlan.skippedEvent}). Disconnect clears
 * them.
 */
export const maxSkipRecords = 1000

/** Rejections the remote expects to clear on their own; the row is sent again on the next pass. */
const transientRejections = new Set(['too_many_lookups'])

/** Rows that will not sync until something changes. */
export const rejectedEntries = (map: IdMap): MapEntry[] =>
  [...map.threads.values(), ...map.messages.values()].filter((e) => e.rejected && !e.deleted)

export type LocalThread = {
  id: string
  title: string | null
  isEncrypted: number | null
  deletedAt: string | null
  /**
   * Unmapped threads only: the remote conversation this thread's id was minted from, when it was (the
   * thread was created from the remote, not written here). Decided by the id alone, so no message the
   * remote sends, whatever its date, can make a thread written here look like the remote's.
   */
  mintedFor?: string | null
  /** The title has not been decrypted on this device yet. */
  isUndecrypted?: boolean
  /**
   * Deleted threads only: what the person chose when deleting it on this device ('everywhere', or
   * 'here-only' to keep it on the remote). Absent when it was deleted without that choice: on another
   * device, or with every other chat at once.
   */
  deleteChoice?: ChatDeleteChoice | null
}

/** How the person chose to delete a synced chat. */
export type ChatDeleteChoice = 'everywhere' | 'here-only'

export type LocalMessage = {
  id: string
  threadId: string | null
  role: string | null
  text: string
  deletedAt: string | null
  /**
   * The reply is still being written: a text or reasoning part is streaming, a tool call has not
   * returned, or the last step ended in a tool result the model has not answered yet.
   */
  isStreaming: boolean
  /**
   * Where the row came from on the remote, when it did (synced `metadata.alpha`), and the
   * fingerprint of the text the bridge wrote there, when it recorded one.
   */
  provenance?: { conversationId: string; messageId: string; textHash?: string } | null
  /** The synced columns have not been decrypted on this device yet. */
  isUndecrypted?: boolean
  /**
   * Soft-deleted by a bridge (on this device or another) because it left the remote's live branch,
   * not by the person. Synced with the row, unlike the map's `dropped`.
   */
  isDropped?: boolean
}

export type LocalSnapshot = { threads: LocalThread[]; messages: LocalMessage[] }

/** A message to insert, and the local message it follows in the thread (by id, as Thunderbolt sorts). */
export type InboundInsert = InboundMessage & { parentId: string | null }

type InboundOptions = {
  /**
   * The smallest id of a thread started after this device connected. Only such a thread can be one
   * this device pushed, so only such a thread can be claimed by a remote row this device has no
   * map entry for.
   */
  syncFrom: string
}

export type InboundPlan = {
  /**
   * Saved once every local write below has landed, so a batch that fails partway records nothing
   * and its replay plans it again in full. A push pass never runs in between (the engine runs pull
   * and push one at a time), so the writes are never pushed back.
   */
  mapWrites: MapEntry[]
  createThreads: { localId: string; title: string }[]
  renameThreads: { localId: string; title: string }[]
  /**
   * Chats to remove once their messages in `deleteMessages` are gone, and only if nothing else is
   * left in them by then: a message the person writes after this plan was made keeps the chat.
   */
  deleteThreads: string[]
  /** Soft-deleted first, before inserts, so new rows parent onto what is still live. */
  deleteMessages: string[]
  /**
   * Those of `deleteMessages` that left the remote's live branch. Each keeps a marker in its synced
   * metadata, written with the delete, so a replay of this batch and every other device read the
   * delete as the bridge's, not the person's.
   */
  dropMessages: { localId: string; conversationId: string; messageId: string }[]
  insertMessages: { threadLocalId: string; messages: InboundInsert[] }[]
  /** Rows soft-deleted here when they left the remote's live branch, back on it now. */
  restoreMessages: { threadLocalId: string; messages: InboundInsert[] }[]
  /** Remote rows whose text changed there (a reply filled in after it was first sent). */
  updateMessages: { threadLocalId: string; messages: InboundMessage[] }[]
  /** Skip records this plan adds as new rows; they count against the day's inbound budget. */
  skipRecords: number
  /**
   * The batch skipped something no record names on its own: a whole event, or a conversation past
   * {@link maxSkipRecords}. Retry reads the stream again from before the first such batch.
   */
  skippedEvent: boolean
}

const sameEntry = (a: MapEntry | undefined, b: MapEntry) =>
  a !== undefined &&
  a.remoteId === b.remoteId &&
  a.source === b.source &&
  (a.title ?? null) === (b.title ?? null) &&
  JSON.stringify(a.remoteTitles ?? []) === JSON.stringify(b.remoteTitles ?? []) &&
  (a.threadLocalId ?? null) === (b.threadLocalId ?? null) &&
  Boolean(a.deleted) === Boolean(b.deleted) &&
  Boolean(a.dropped) === Boolean(b.dropped) &&
  a.hash === b.hash &&
  a.rejected === b.rejected

/**
 * Decide what one batch of remote changes does locally.
 *
 * - A row the remote says this app pushed is accepted under that id only when this device can
 *   confirm it: the map says it was pushed from here, or the row exists locally (for a thread, a
 *   non-private one started after connecting; for a message, in the same thread). An unconfirmed
 *   claim is skipped, never minted, so the remote can't address other local rows by naming their
 *   ids. A claim on a row deleted here before the push's answer arrived is only mapped, so the
 *   delete is pushed; nothing local is written.
 * - A thread or message soft-deleted here stays deleted: the local delete is pushed instead.
 * - A rename from the remote applies only while the local title still equals the last agreed one;
 *   an unpushed local rename wins and is pushed next. A local title that already equals the remote's
 *   becomes the agreed one. A local title not decrypted here yet is never recorded as agreed.
 * - A remote message whose text changed there (a reply that was empty when first sent) is updated
 *   here, unless the local text changed too: against the map's fingerprint, or, on a device with no
 *   map entry for the row, the one that synced with it.
 * - Messages written here from the remote that drop off its live branch (a regeneration there) are
 *   soft-deleted, and brought back if the branch switches back to them. One still on the branch but
 *   unplaced on this device (its clock is behind) stays. One the person deleted here stays deleted.
 *   Whether a deleted row was dropped is read from the marker that synced with it, never from this
 *   device's map alone, and a deleted row not yet decrypted here waits.
 * - Message ids are minted against the chat the map names for the conversation (`engine.ts`
 *   re-mints them with `placeOnLocalThread` first), so none sorts before that chat began.
 * - A remote message this device has no map entry for, but which a local row in the same thread
 *   already carries in its provenance (another device wrote it, under an id minted from wire data
 *   that has since changed), is matched to that row instead of inserted again.
 * - An inserted message's parent is the live message just before it by id, the order Thunderbolt
 *   shows, so deleting a message with its descendants never takes rows shown above it.
 * - A conversation or message the same event also tombstones is not written: the tombstone is its
 *   latest state, and applies to what was here before the event.
 * - A tombstone deletes a local row only when the row came from the remote. For a row written in
 *   Thunderbolt it only ends the mapping: the remote can't delete what this app owns. A deleted
 *   conversation removes the whole chat only when the chat came from the remote and every message
 *   left in it did too; otherwise only the remote's messages go, and the chat stays, unmapped.
 * - A conversation the batch skipped (past a limit, or unreadable) is recorded as not synced. The
 *   record clears when the conversation later arrives whole, or is deleted there. Past
 *   {@link maxSkipRecords} records, a skip is left to the event's own replay on Retry.
 */
export const planInbound = (
  batch: InboundBatch,
  map: IdMap,
  local: LocalSnapshot,
  { syncFrom }: InboundOptions,
): InboundPlan => {
  const plan: InboundPlan = {
    mapWrites: [],
    createThreads: [],
    renameThreads: [],
    deleteThreads: [],
    deleteMessages: [],
    dropMessages: [],
    insertMessages: [],
    restoreMessages: [],
    updateMessages: [],
    skipRecords: 0,
    skippedEvent: false,
  }
  const threadsById = new Map(local.threads.map((t) => [t.id, t]))
  const messagesById = new Map(local.messages.map((m) => [m.id, m]))
  const messagesInThread = new Map<string, LocalMessage[]>()
  for (const m of local.messages) {
    if (!m.threadId) {
      continue
    }
    const inThread = messagesInThread.get(m.threadId)
    if (inThread) {
      inThread.push(m)
    } else {
      messagesInThread.set(m.threadId, [m])
    }
  }
  const write = (entry: MapEntry) => {
    const current = (entry.kind === 'thread' ? map.threads : map.messages).get(entry.localId)
    if (!sameEntry(current, entry)) {
      plan.mapWrites.push(entry)
    }
  }
  // What this same event also deletes: the delete is the latest state, so the content is not
  // written, and the tombstones below apply to what was here before the event.
  const tombstoned = { thread: new Set<string>(), message: new Set<string>() }
  for (const tombstone of batch.tombstones) {
    tombstoned[tombstone.kind].add(tombstone.remoteId)
  }

  for (const thread of batch.threads) {
    if (tombstoned.thread.has(thread.remoteId)) {
      continue
    }
    const known = map.threadsByRemote.get(thread.remoteId)
    const localId = known?.localId ?? thread.localId
    if (!known && thread.isEcho) {
      const row = threadsById.get(localId)
      const confirmed =
        map.threads.get(localId)?.source === 'local' ||
        (row !== undefined && row.isEncrypted !== 1 && localId >= syncFrom)
      if (!confirmed) {
        continue
      }
    }
    const entry = map.threads.get(localId)
    const existing = threadsById.get(localId)
    if (existing?.deletedAt && !entry && thread.isEcho) {
      // Pushed from here, its answer lost, and deleted before this echo: mapped now, so the delete
      // is sent.
      write({ kind: 'thread', localId, remoteId: thread.remoteId, source: 'local', title: null })
      continue
    }
    if (existing?.deletedAt || entry?.deleted || existing?.isEncrypted === 1) {
      continue
    }
    const source = entry?.source ?? (thread.isEcho ? 'local' : 'remote')

    let agreedTitle: string | null = thread.title
    if (!existing) {
      plan.createThreads.push({ localId, title: thread.title })
    } else if (existing.isUndecrypted) {
      // The local title can't be compared yet, and its ciphertext is never an agreed title: keep
      // the last agreed one, or take the remote's, so a later rename there still applies.
      agreedTitle = entry ? (entry.title ?? null) : thread.title
    } else if (entry && existing.title === (entry.title ?? null) && existing.title !== thread.title) {
      plan.renameThreads.push({ localId, title: thread.title })
    } else if (entry && existing.title === thread.title) {
      // Both sides already hold this title (the person typed it, or another browser pulled the
      // rename first and Thunderbolt's sync brought it here): it is the agreed one now, so the
      // remote's next rename still applies.
    } else if (entry) {
      agreedTitle = entry.title ?? null
    } else {
      agreedTitle = existing.title
    }
    write({
      kind: 'thread',
      localId,
      remoteId: thread.remoteId,
      source,
      title: agreedTitle,
      remoteTitles: withRemoteTitle(entry?.remoteTitles, thread.title),
    })
    const skipRecord = map.threads.get(skippedKey(thread.remoteId, batch.cursor))
    if (skipRecord && !skipRecord.deleted) {
      plan.mapWrites.push({ ...skipRecord, deleted: true })
    }
    const provenanceMatches = new Map<string, string>()
    for (const m of messagesInThread.get(localId) ?? []) {
      if (m.provenance?.conversationId === thread.remoteId) {
        provenanceMatches.set(m.provenance.messageId, m.id)
      }
    }

    const live = new Set<string>()
    const inserts: InboundInsert[] = []
    const restores: InboundInsert[] = []
    const updates: InboundMessage[] = []
    for (const message of thread.messages) {
      const knownMessage = map.messagesByRemote.get(message.remoteId)
      if (tombstoned.message.has(message.remoteId)) {
        // Still on the branch until its tombstone below removes it, so not dropped as well.
        if (knownMessage) {
          live.add(knownMessage.localId)
        }
        continue
      }
      const adopted = message.isEcho ? undefined : provenanceMatches.get(message.remoteId)
      const messageLocalId = knownMessage?.localId ?? adopted ?? message.localId
      const existingMessage = messagesById.get(messageLocalId)
      if (!knownMessage && message.isEcho) {
        const claimed = map.messages.get(messageLocalId)
        if (!claimed && existingMessage?.deletedAt && messageLocalId >= syncFrom) {
          // Pushed from here, its answer lost, and deleted before this echo (a deleted row has lost
          // its thread link, so that can't confirm it). Mapped now, so the delete is sent; the
          // remote only learns its own row is gone.
          write({
            kind: 'message',
            localId: messageLocalId,
            remoteId: message.remoteId,
            source: 'local',
            threadLocalId: localId,
          })
          continue
        }
        if (claimed?.source !== 'local' && existingMessage?.threadId !== localId) {
          continue
        }
      }
      live.add(messageLocalId)
      const messageEntry = map.messages.get(messageLocalId)
      if (messageEntry?.deleted) {
        continue
      }
      const isDeletedHere = Boolean(existingMessage?.deletedAt)
      if (isDeletedHere && existingMessage?.isUndecrypted) {
        // Whose delete it was is in the row's metadata, which this device can't read yet.
        continue
      }
      // Only the marker that synced with the row says a bridge dropped it. This device's map may
      // still say `dropped` after another device restored the row and the person then deleted it.
      const isReturning = isDeletedHere && existingMessage?.isDropped === true
      if (isDeletedHere && !isReturning) {
        if (messageEntry?.dropped) {
          // The person's delete, which no push pass reads while the map says dropped: recorded here.
          plan.mapWrites.push({ ...messageEntry, deleted: true })
        }
        continue
      }
      const messageSource = messageEntry?.source ?? (message.isEcho ? 'local' : 'remote')
      const remoteHash = textHash(message.text)
      const row = { ...message, localId: messageLocalId }

      if (!existingMessage || isReturning) {
        if (message.role === 'assistant' && message.text.trim() === '') {
          // A reply AI Potluck has not written yet. It arrives again once it has text.
          continue
        }
        ;(isReturning ? restores : inserts).push({ ...row, parentId: null })
        write({
          kind: 'message',
          localId: messageLocalId,
          remoteId: message.remoteId,
          source: messageSource,
          threadLocalId: localId,
          hash: remoteHash,
        })
        continue
      }

      let hash = messageEntry?.hash
      if (messageSource === 'remote' && remoteHash !== hash && !existingMessage.isUndecrypted) {
        const localHash = textHash(existingMessage.text)
        // With no map entry (this device connected after another wrote the row), the fingerprint
        // that synced with the row says whether it is still as the bridge wrote it.
        const written =
          hash ??
          (existingMessage.provenance?.messageId === message.remoteId ? existingMessage.provenance.textHash : undefined)
        const untouchedHere = written !== undefined ? localHash === written : existingMessage.text.trim() === ''
        if (localHash === remoteHash) {
          hash = remoteHash
        } else if (untouchedHere && message.text.trim() !== '') {
          updates.push(row)
          hash = remoteHash
        }
      }
      write({
        kind: 'message',
        localId: messageLocalId,
        remoteId: message.remoteId,
        source: messageSource,
        threadLocalId: localId,
        hash,
      })
    }
    if (inserts.length) {
      plan.insertMessages.push({ threadLocalId: localId, messages: inserts })
    }
    if (restores.length) {
      plan.restoreMessages.push({ threadLocalId: localId, messages: restores })
    }
    if (updates.length) {
      plan.updateMessages.push({ threadLocalId: localId, messages: updates })
    }
    for (const remoteId of thread.unplaced ?? []) {
      const knownMessage = map.messagesByRemote.get(remoteId)
      if (knownMessage) {
        live.add(knownMessage.localId)
      }
    }

    for (const messageId of map.messagesByThread.get(localId) ?? []) {
      const messageEntry = map.messages.get(messageId)
      if (
        !messageEntry ||
        messageEntry.source !== 'remote' ||
        !messageEntry.remoteId ||
        messageEntry.deleted ||
        messageEntry.dropped ||
        live.has(messageId)
      ) {
        continue
      }
      const row = messagesById.get(messageId)
      if (row?.deletedAt && row.isUndecrypted) {
        // Whose delete it was is in the row's metadata, which this device can't read yet.
        continue
      }
      if (row?.deletedAt && !row.isDropped) {
        // Deleted before it left the branch, and not by a bridge: the person's delete, and it stays.
        plan.mapWrites.push({ ...messageEntry, deleted: true })
        continue
      }
      if (row && !row.deletedAt) {
        plan.deleteMessages.push(messageId)
        plan.dropMessages.push({
          localId: messageId,
          conversationId: thread.remoteId,
          messageId: messageEntry.remoteId,
        })
      }
      plan.mapWrites.push({ ...messageEntry, dropped: true })
    }
  }

  for (const tombstone of batch.tombstones) {
    const skipRecord = tombstone.kind === 'thread' ? map.threads.get(skippedKey(tombstone.remoteId, null)) : undefined
    if (skipRecord && !skipRecord.deleted) {
      plan.mapWrites.push({ ...skipRecord, deleted: true })
    }
    const entry = (tombstone.kind === 'thread' ? map.threadsByRemote : map.messagesByRemote).get(tombstone.remoteId)
    if (!entry || entry.deleted) {
      continue
    }
    if (tombstone.kind === 'message') {
      const row = messagesById.get(entry.localId)
      if (entry.source === 'remote' && row && !row.deletedAt) {
        plan.deleteMessages.push(entry.localId)
      }
    } else {
      const row = threadsById.get(entry.localId)
      const live = (messagesInThread.get(entry.localId) ?? []).filter((m) => !m.deletedAt)
      const isRemoteRow = (m: LocalMessage) => {
        const messageEntry = map.messages.get(m.id)
        return messageEntry ? messageEntry.source === 'remote' : m.provenance?.conversationId === tombstone.remoteId
      }
      if (entry.source === 'remote' && row && !row.deletedAt && live.every(isRemoteRow)) {
        // Only these messages go; the engine removes the chat after them if nothing else is in it.
        plan.deleteMessages.push(...live.map((m) => m.id))
        plan.deleteThreads.push(entry.localId)
      } else {
        // The chat holds the person's own messages (or was started here): it stays, and only what
        // came from the remote goes.
        plan.deleteMessages.push(...live.filter(isRemoteRow).map((m) => m.id))
      }
    }
    plan.mapWrites.push({ ...entry, deleted: true })
    if (tombstone.kind === 'thread') {
      // The thread's messages are unmapped either way, so a later local delete is not pushed to a
      // conversation that no longer exists.
      for (const messageId of map.messagesByThread.get(entry.localId) ?? []) {
        const messageEntry = map.messages.get(messageId)
        if (messageEntry && !messageEntry.deleted) {
          plan.mapWrites.push({ ...messageEntry, deleted: true })
        }
      }
    }
  }

  // Skip records already in the map, cleared ones included, and the keys this plan adds.
  let skipRows = 0
  if (batch.skipped?.length) {
    for (const entry of map.threads.values()) {
      if (isSkipRecord(entry)) {
        skipRows += 1
      }
    }
  }
  const addedSkipKeys = new Set<string>()
  for (const skip of batch.skipped ?? []) {
    if (skip.remoteId === null) {
      plan.skippedEvent = true
    }
    const existing = skip.remoteId === null ? undefined : map.threadsByRemote.get(skip.remoteId)
    if (existing && !existing.deleted) {
      // Keep the mapping; only mark that the latest version did not arrive.
      plan.mapWrites.push({ ...existing, rejected: skip.reason })
      continue
    }
    if (existing) {
      continue
    }
    const localId = skippedKey(skip.remoteId, batch.cursor)
    const isNewRow = !map.threads.has(localId) && !addedSkipKeys.has(localId)
    if (isNewRow && skipRows + addedSkipKeys.size >= maxSkipRecords) {
      // Recorded by the event instead, which Retry reads again.
      plan.skippedEvent = true
      continue
    }
    if (isNewRow) {
      addedSkipKeys.add(localId)
    }
    plan.mapWrites.push({ kind: 'thread', localId, remoteId: null, source: 'remote', rejected: skip.reason })
  }
  plan.skipRecords = addedSkipKeys.size

  // Parents last, once every delete in the batch is known: each insert or restore follows the live
  // message just before it by id.
  const deleted = new Set(plan.deleteMessages)
  const placing = new Map<string, InboundInsert[]>()
  for (const group of [...plan.insertMessages, ...plan.restoreMessages]) {
    placing.set(group.threadLocalId, [...(placing.get(group.threadLocalId) ?? []), ...group.messages])
  }
  for (const [threadLocalId, messages] of placing) {
    const ids = [
      ...(messagesInThread.get(threadLocalId) ?? []).filter((m) => !m.deletedAt && !deleted.has(m.id)).map((m) => m.id),
      ...messages.map((m) => m.localId),
    ].sort()
    const position = new Map(ids.map((id, index) => [id, index]))
    for (const message of messages) {
      const index = position.get(message.localId) ?? 0
      message.parentId = index > 0 ? ids[index - 1] : null
    }
  }
  return plan
}

type OutboundOptions = {
  /**
   * Assistant messages still being written are held back until this says yes. It must say yes
   * eventually even for a reply whose parts never finish (one stopped or failed mid-stream), or every
   * later message in the thread waits with it.
   */
  isSettled: (message: LocalMessage) => boolean
  /**
   * An assistant message has not changed for the stall window. An empty reply is recorded as not
   * synced once this says yes, so empty replies can't pile up and fill every pass's page of rows.
   */
  isStalled: (message: LocalMessage) => boolean
  /** Creation time of a row; Thunderbolt's ids are UUIDv7. */
  createdAt: (id: string) => string
  /**
   * The smallest id of a thread started after this device connected. Older threads that never
   * synced stay local: connecting does not upload the person's history.
   */
  syncFrom: string
  /** The remote's per-message limit; longer messages are recorded as not synced. */
  maxContentChars: number
}

export type OutboundPlan = {
  batch: OutboundBatch
  /** Recorded before the push: rows adopted from provenance, rows that will never be sent. */
  mapWrites: MapEntry[]
  /** Some message is waiting to settle or to fill; plan again later. */
  isHolding: boolean
}

/**
 * Decide what to push.
 *
 * - Mapped rows are never pushed as new; an unmapped row that carries provenance is adopted into
 *   the map instead (another device wrote it from the remote), once its chat's title is decrypted.
 * - Private chats (`is_encrypted` = 1) never leave the device, and neither do rows this device has
 *   not decrypted yet.
 * - A thread is pushed as new only together with its first message, and only when it was started
 *   after connecting.
 * - Within a thread, messages go in order: once one is held back (a reply still being written),
 *   the ones after it wait too, so the remote never stores a turn out of order.
 * - System messages, empty user messages and messages past the remote's size limit are recorded as
 *   not synced rather than retried forever. An assistant reply with no text yet is skipped without
 *   holding the thread: it may still fill (a reply that so far only called tools), and it is sent
 *   once it has text. Once it has stayed empty for the stall window it is recorded as not synced.
 * - A delete is pushed only for a message written in Thunderbolt. One that came from the remote is
 *   only unmapped: this device may have deleted it because it left the remote's live branch (a
 *   regeneration there), and pushing that delete would remove the remote's other versions.
 * - A chat deleted here is one delete of the whole conversation on the remote, or none; the
 *   messages deleted with it are only unmapped. The person's choice when deleting it here decides
 *   ('everywhere' or 'here-only'). Without one (it was deleted on another device, or with every
 *   other chat at once) a chat started in Thunderbolt is deleted there and one that came from the
 *   remote is not, so clearing chats here never deletes the remote's conversations unasked.
 *   Deleting one message in a chat that stays is pushed as before.
 * - A rename is not pushed when the local title is one the remote itself sent recently: another
 *   device wrote it from the remote and it reached this one late.
 */
export const planOutbound = (local: LocalSnapshot, map: IdMap, options: OutboundOptions): OutboundPlan => {
  const threadsById = new Map(local.threads.map((t) => [t.id, t]))
  const mapWrites: MapEntry[] = []
  const messages: OutboundMessage[] = []
  const newThreadIds = new Set<string>()
  const adoptedThreads = new Map<string, string>()
  const heldThreads = new Set<string>()
  let isHolding = false

  const sorted = [...local.messages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const m of sorted) {
    const entry = map.messages.get(m.id)
    if (m.deletedAt) {
      // A row dropped off the remote's branch was deleted by this bridge, not the person: nothing to send.
      if (entry && !entry.deleted && !entry.dropped && !m.isUndecrypted) {
        if (m.isDropped) {
          // Another device's bridge dropped it (the marker synced with the row): not the person's delete.
          mapWrites.push({ ...entry, dropped: true })
          continue
        }
        const threadLocalId = entry.threadLocalId ?? null
        const threadEntry = threadLocalId ? map.threads.get(threadLocalId) : undefined
        // The whole chat was deleted here: at most one delete of the whole conversation goes out
        // (see the threads below), never one per message.
        const isChatDeleted =
          threadEntry !== undefined &&
          (threadEntry.deleted === true || Boolean(threadsById.get(threadEntry.localId)?.deletedAt))
        if (!entry.remoteId || entry.source === 'remote' || isChatDeleted) {
          mapWrites.push({ ...entry, deleted: true })
          continue
        }
        messages.push({
          localId: m.id,
          remoteId: entry.remoteId,
          threadLocalId,
          threadRemoteId: threadLocalId ? (map.threads.get(threadLocalId)?.remoteId ?? null) : null,
          role: m.role === 'assistant' ? 'assistant' : 'user',
          text: '',
          createdAt: options.createdAt(m.id),
          deletedAt: m.deletedAt,
        })
      }
      continue
    }
    if (entry) {
      continue
    }
    const thread = m.threadId ? threadsById.get(m.threadId) : undefined
    if (!thread || thread.deletedAt || thread.isEncrypted === 1) {
      continue
    }
    const threadEntry = map.threads.get(thread.id)

    if (m.provenance) {
      if (!threadEntry && !adoptedThreads.has(thread.id) && thread.isUndecrypted) {
        // Adopting the chat records its title as agreed, and this one is still ciphertext here.
        isHolding = true
        continue
      }
      mapWrites.push({
        kind: 'message',
        localId: m.id,
        remoteId: m.provenance.messageId,
        source: 'remote',
        threadLocalId: thread.id,
        hash: textHash(m.text),
      })
      if (!threadEntry && !adoptedThreads.has(thread.id)) {
        adoptedThreads.set(thread.id, m.provenance.conversationId)
        mapWrites.push({
          kind: 'thread',
          localId: thread.id,
          remoteId: m.provenance.conversationId,
          source: thread.mintedFor === m.provenance.conversationId ? 'remote' : 'local',
          title: thread.title,
        })
      }
      continue
    }

    const threadRemoteId = threadEntry?.remoteId ?? adoptedThreads.get(thread.id) ?? null
    if (threadEntry && (threadEntry.deleted || !threadEntry.remoteId)) {
      continue
    }
    if (!threadEntry && !adoptedThreads.has(thread.id) && thread.id < options.syncFrom) {
      continue
    }
    if (heldThreads.has(thread.id)) {
      continue
    }
    if (m.isUndecrypted || thread.isUndecrypted || !options.isSettled(m)) {
      heldThreads.add(thread.id)
      isHolding = true
      continue
    }
    const reject = (reason: string) =>
      mapWrites.push({
        kind: 'message',
        localId: m.id,
        remoteId: null,
        source: 'local',
        threadLocalId: thread.id,
        rejected: reason,
      })
    if (m.role !== 'user' && m.role !== 'assistant') {
      reject('unsupported-role')
      continue
    }
    if (m.text.trim() === '') {
      if (m.role === 'user' || options.isStalled(m)) {
        reject('empty')
      } else {
        // Plan again later, so the reply is sent once it fills or recorded once it stalls.
        isHolding = true
      }
      continue
    }
    if (m.text.length > options.maxContentChars) {
      reject('too-large')
      continue
    }
    if (!threadRemoteId) {
      newThreadIds.add(thread.id)
    }
    messages.push({
      localId: m.id,
      remoteId: null,
      threadLocalId: thread.id,
      threadRemoteId,
      role: m.role,
      text: m.text,
      createdAt: options.createdAt(m.id),
      deletedAt: null,
    })
  }

  const threads: OutboundThread[] = []
  for (const t of local.threads) {
    const entry = map.threads.get(t.id)
    const base = { localId: t.id, remoteId: entry?.remoteId ?? null, createdAt: options.createdAt(t.id) }
    if (!entry) {
      if (newThreadIds.has(t.id)) {
        threads.push({ ...base, title: t.title, deletedAt: null })
      }
      continue
    }
    if (entry.deleted) {
      continue
    }
    if (t.deletedAt) {
      const sendsDelete = t.deleteChoice ? t.deleteChoice === 'everywhere' : entry.source === 'local'
      if (entry.remoteId && sendsDelete) {
        threads.push({ ...base, title: null, deletedAt: t.deletedAt })
      } else {
        mapWrites.push({ ...entry, deleted: true })
      }
      continue
    }
    const isRemoteTitle = entry.remoteTitles?.includes(t.title ?? '') ?? false
    if (
      entry.remoteId &&
      t.isEncrypted !== 1 &&
      !t.isUndecrypted &&
      t.title &&
      t.title !== entry.title &&
      !isRemoteTitle
    ) {
      threads.push({ ...base, title: t.title, deletedAt: null })
    }
  }
  return { batch: { threads, messages }, mapWrites, isHolding }
}

export type AckResult = {
  mapWrites: MapEntry[]
  /** The remote asked for some rows to be sent again later. */
  retryLater: boolean
}

/**
 * Map entries that record what the remote did with a push.
 *
 * - An acknowledged row is mapped to its remote id.
 * - A refused new row is recorded with the reason and not sent again; the local row is untouched,
 *   and Retry on the card clears the record. A refused delete or rename of a row the remote no
 *   longer has ends the mapping.
 * - A new row the remote neither acknowledged nor refused stays unmapped and is sent again.
 */
export const mapWritesForAck = (batch: OutboundBatch, ack: PushAck, map: IdMap): AckResult => {
  const ackedThreads = new Map(ack.threads.map((a) => [a.localId, a.remoteId]))
  const ackedMessages = new Map(ack.messages.map((a) => [a.localId, a.remoteId]))
  const refusals = new Map(ack.rejected.map((r) => [`${r.kind}:${r.localId}`, r.reason]))
  const mapWrites: MapEntry[] = []
  let retryLater = false

  for (const t of batch.threads) {
    const prior = map.threads.get(t.localId)
    const reason = refusals.get(`thread:${t.localId}`)
    const remoteId = ackedThreads.get(t.localId) ?? t.remoteId
    const base: MapEntry = {
      kind: 'thread',
      localId: t.localId,
      remoteId,
      source: prior?.source ?? 'local',
      remoteTitles: prior?.remoteTitles,
    }
    if (reason && transientRejections.has(reason)) {
      retryLater = true
      continue
    }
    if (t.deletedAt) {
      mapWrites.push({ ...base, title: prior?.title ?? null, deleted: true })
    } else if (reason && t.remoteId) {
      // A rename the remote refused: a conversation it no longer has is gone; otherwise keep the
      // local title and stop sending it.
      mapWrites.push({ ...base, title: t.title, deleted: reason === 'not_found' || undefined })
    } else if (reason) {
      mapWrites.push({ ...base, remoteId: null, title: t.title, rejected: reason })
    } else if (remoteId) {
      mapWrites.push({ ...base, title: t.title })
    }
  }

  for (const m of batch.messages) {
    const prior = map.messages.get(m.localId)
    const reason = refusals.get(`message:${m.localId}`)
    const remoteId = ackedMessages.get(m.localId) ?? m.remoteId
    const base: MapEntry = {
      kind: 'message',
      localId: m.localId,
      remoteId,
      source: prior?.source ?? 'local',
      threadLocalId: m.threadLocalId,
      hash: prior?.hash,
    }
    if (reason && transientRejections.has(reason)) {
      retryLater = true
      continue
    }
    if (m.deletedAt) {
      mapWrites.push({ ...base, deleted: true })
    } else if (reason) {
      mapWrites.push({ ...base, remoteId: null, rejected: reason })
    } else if (ackedMessages.has(m.localId)) {
      mapWrites.push({ ...base, hash: textHash(m.text) })
    }
  }
  return { mapWrites, retryLater }
}

export const isEmptyBatch = (batch: OutboundBatch) => batch.threads.length === 0 && batch.messages.length === 0

export type ChunkLimits = { threads: number; messages: number; bytes: number }

const encodedSize = (row: unknown) => new TextEncoder().encode(JSON.stringify(row)).length

/**
 * Cut a batch into pushes that fit the remote's limits, with headroom for the envelope. Threads go
 * first, so a message never travels ahead of the new thread it belongs to.
 */
export const chunkBatch = (
  batch: OutboundBatch,
  limits: ChunkLimits,
  sizeOf: (row: OutboundThread | OutboundMessage) => number = encodedSize,
): OutboundBatch[] => {
  const chunks: OutboundBatch[] = []
  let current: OutboundBatch = { threads: [], messages: [] }
  let bytes = 0
  const add = (row: OutboundThread | OutboundMessage, isThread: boolean) => {
    const size = sizeOf(row)
    const full =
      (isThread ? current.threads.length + 1 > limits.threads : current.messages.length + 1 > limits.messages) ||
      bytes + size > limits.bytes
    if (full && !isEmptyBatch(current)) {
      chunks.push(current)
      current = { threads: [], messages: [] }
      bytes = 0
    }
    if (isThread) {
      current.threads.push(row as OutboundThread)
    } else {
      current.messages.push(row as OutboundMessage)
    }
    bytes += size
  }
  batch.threads.forEach((t) => add(t, true))
  batch.messages.forEach((m) => add(m, false))
  if (!isEmptyBatch(current)) {
    chunks.push(current)
  }
  return chunks
}

/** Split a batch in two halves, for finding the row a remote refuses outright. */
export const splitBatch = (batch: OutboundBatch): [OutboundBatch, OutboundBatch] => {
  const rows = [...batch.threads.map((t) => ['t', t] as const), ...batch.messages.map((m) => ['m', m] as const)]
  const half = Math.ceil(rows.length / 2)
  const toBatch = (part: typeof rows): OutboundBatch => ({
    threads: part.filter(([k]) => k === 't').map(([, r]) => r as OutboundThread),
    messages: part.filter(([k]) => k === 'm').map(([, r]) => r as OutboundMessage),
  })
  return [toBatch(rows.slice(0, half)), toBatch(rows.slice(half))]
}

export const batchSize = (batch: OutboundBatch) => batch.threads.length + batch.messages.length
