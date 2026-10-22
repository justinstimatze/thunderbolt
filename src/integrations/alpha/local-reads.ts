/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, not, or, sql, type Column } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { isEncryptedValue } from '@/db/encryption'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { isMintedThreadId } from './map'
import { readProvenance } from './provenance'
import type { LocalMessage, LocalSnapshot, LocalThread } from './plan'
import { chatDeleteChoicePrefix, chunked } from './storage'
import { alphaSyncStateTable } from './tables'

/*
 * The bridge's reads of the chat tables. They query the tables directly rather than through the
 * DAL because each one joins a chat table to the bridge's own id map, so a pass reads only the rows
 * that may need syncing instead of the whole history. They never write.
 *
 * The synced columns are read as raw text: a row that has not been decrypted on this device yet
 * holds an encrypted wire value there (see `encPrefix`), which must be recognised, never parsed or
 * pushed.
 */

type RawMessage = {
  id: string
  threadId: string | null
  role: string | null
  parts: string | null
  content: string | null
  metadata: string | null
  deletedAt: string | null
}

const rawMessageColumns = {
  id: chatMessagesTable.id,
  threadId: chatMessagesTable.chatThreadId,
  role: chatMessagesTable.role,
  parts: sql<string | null>`${chatMessagesTable.parts}`,
  content: sql<string | null>`${chatMessagesTable.content}`,
  metadata: sql<string | null>`${chatMessagesTable.metadata}`,
  deletedAt: chatMessagesTable.deletedAt,
}

type StoredPart = { type?: unknown; text?: unknown; state?: unknown }

const isUndecrypted = (value: string | null) => value !== null && isEncryptedValue(value)

const isToolPart = (p: StoredPart | undefined) =>
  typeof p?.type === 'string' && (p.type.startsWith('tool-') || p.type === 'dynamic-tool')

/** A tool call whose input is still arriving, or that has not returned yet. */
const isToolPending = (p: StoredPart | undefined) =>
  isToolPart(p) && (p?.state === 'input-streaming' || p?.state === 'input-available')

/**
 * A message's text as Thunderbolt renders it (its text parts), and whether the reply is still being
 * written: a text or reasoning part is streaming, a tool call is pending, or the message ends on a
 * tool result or a step start, after which the model writes again.
 */
export const partsText = (parts: unknown, content: string | null): { text: string; isStreaming: boolean } => {
  if (!Array.isArray(parts)) {
    return { text: content ?? '', isStreaming: false }
  }
  const typed = parts as StoredPart[]
  const lastPart = typed.at(-1)
  return {
    text: typed
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join(''),
    isStreaming:
      typed.some(
        (p) => ((p?.type === 'text' || p?.type === 'reasoning') && p.state === 'streaming') || isToolPending(p),
      ) ||
      isToolPart(lastPart) ||
      lastPart?.type === 'step-start',
  }
}

const parseJson = (value: string | null): unknown => {
  if (value === null) {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export const toLocalMessage = (row: RawMessage): LocalMessage => {
  const base = { id: row.id, threadId: row.threadId, role: row.role, deletedAt: row.deletedAt }
  if (isUndecrypted(row.parts) || isUndecrypted(row.content) || isUndecrypted(row.metadata)) {
    return { ...base, text: '', isStreaming: false, provenance: null, isUndecrypted: true }
  }
  const provenance = readProvenance(parseJson(row.metadata))
  return {
    ...base,
    ...partsText(parseJson(row.parts), row.content),
    provenance: provenance
      ? {
          conversationId: provenance.conversationId,
          messageId: provenance.messageId,
          ...(typeof provenance.textHash === 'string' ? { textHash: provenance.textHash } : {}),
        }
      : null,
    ...(row.deletedAt && provenance?.dropped === true ? { isDropped: true } : {}),
  }
}

const threadColumns = {
  id: chatThreadsTable.id,
  title: chatThreadsTable.title,
  isEncrypted: chatThreadsTable.isEncrypted,
  deletedAt: chatThreadsTable.deletedAt,
}

/** A thread as plans read it; a title not yet decrypted here is flagged, so it is never pushed. */
const toLocalThread = (row: Omit<LocalThread, 'isUndecrypted'>): LocalThread =>
  isUndecrypted(row.title) ? { ...row, isUndecrypted: true } : row

/** `json_extract(value, '$.deleted')` is unset or false: the map entry is live. */
const mapEntryIsLive = (value: Column) => sql`coalesce(json_extract(${value}, '$.deleted'), 0) = 0`

/** The bridge itself deleted the row, when it left the remote's live branch: no delete to send. */
const mapEntryIsDropped = (value: Column) => sql`coalesce(json_extract(${value}, '$.dropped'), 0) = 1`

export const readThreads = async (db: AnyDrizzleDatabase, ids: string[]): Promise<LocalThread[]> => {
  const threads: LocalThread[] = []
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = await db.select(threadColumns).from(chatThreadsTable).where(inArray(chatThreadsTable.id, chunk))
    threads.push(...rows.map(toLocalThread))
  }
  return threads
}

export const readMessages = async (db: AnyDrizzleDatabase, ids: string[]): Promise<LocalMessage[]> => {
  const messages: LocalMessage[] = []
  for (const chunk of chunked([...new Set(ids)])) {
    const rows = await db.select(rawMessageColumns).from(chatMessagesTable).where(inArray(chatMessagesTable.id, chunk))
    messages.push(...rows.map(toLocalMessage))
  }
  return messages
}

/** Every message in these threads, live or deleted (a deleted one has lost its thread link). */
export const readThreadMessages = async (db: AnyDrizzleDatabase, threadIds: string[]): Promise<LocalMessage[]> => {
  const messages: LocalMessage[] = []
  for (const chunk of chunked([...new Set(threadIds)])) {
    const rows = await db
      .select(rawMessageColumns)
      .from(chatMessagesTable)
      .where(inArray(chatMessagesTable.chatThreadId, chunk))
    messages.push(...rows.map(toLocalMessage))
  }
  return messages
}

export type OutboundCandidates = LocalSnapshot & {
  /** More unsynced messages wait beyond `limit`. */
  hasMore: boolean
}

/**
 * The rows a push pass has to consider, and nothing else:
 * - live messages with no map entry, in non-private threads that are either mapped (every such
 *   message) or were started after `syncFrom` (an id floor, on the thread and the message);
 * - mapped messages and threads deleted here whose delete has not been sent, and the chat each such
 *   message was in;
 * - mapped threads whose title changed here, and for a deleted one, how the person chose to delete it.
 */
export const readOutboundCandidates = async (
  db: AnyDrizzleDatabase,
  { syncFrom, limit }: { syncFrom: string; limit: number },
): Promise<OutboundCandidates> => {
  const messageState = alias(alphaSyncStateTable, 'alpha_message_state')
  const threadState = alias(alphaSyncStateTable, 'alpha_thread_state')

  const unsynced = await db
    .select(rawMessageColumns)
    .from(chatMessagesTable)
    .innerJoin(chatThreadsTable, eq(chatThreadsTable.id, chatMessagesTable.chatThreadId))
    .leftJoin(messageState, eq(messageState.id, sql`'message:' || ${chatMessagesTable.id}`))
    .leftJoin(threadState, eq(threadState.id, sql`'thread:' || ${chatThreadsTable.id}`))
    .where(
      and(
        isNull(chatMessagesTable.deletedAt),
        isNull(chatThreadsTable.deletedAt),
        or(isNull(chatThreadsTable.isEncrypted), ne(chatThreadsTable.isEncrypted, 1)),
        isNull(messageState.id),
        or(
          // A chat not synced yet: only one started after the window opened, and only its messages
          // from then on.
          and(isNull(threadState.id), gte(chatThreadsTable.id, syncFrom), gte(chatMessagesTable.id, syncFrom)),
          // A synced chat syncs whole, whatever the window, so a turn written while this device was
          // disconnected is never left out of the middle of the remote copy.
          and(isNotNull(threadState.remoteId), mapEntryIsLive(threadState.value)),
        ),
      ),
    )
    .orderBy(asc(chatMessagesTable.id))
    .limit(limit + 1)

  const deletedMessages = await db
    .select({
      ...rawMessageColumns,
      // A deleted message has lost its thread link; the map still names the chat.
      mappedThreadId: sql<string | null>`json_extract(${alphaSyncStateTable.value}, '$.threadLocalId')`,
    })
    .from(alphaSyncStateTable)
    .innerJoin(chatMessagesTable, eq(chatMessagesTable.id, alphaSyncStateTable.localId))
    .where(
      and(
        eq(alphaSyncStateTable.kind, 'message'),
        mapEntryIsLive(alphaSyncStateTable.value),
        not(mapEntryIsDropped(alphaSyncStateTable.value)),
        isNotNull(chatMessagesTable.deletedAt),
      ),
    )
    .limit(limit + 1)

  const deleteChoice = alias(alphaSyncStateTable, 'alpha_delete_choice')
  const changedThreads = await db
    .select({ ...threadColumns, deleteChoice: deleteChoice.value })
    .from(alphaSyncStateTable)
    .innerJoin(chatThreadsTable, eq(chatThreadsTable.id, alphaSyncStateTable.localId))
    .leftJoin(deleteChoice, eq(deleteChoice.id, sql`${chatDeleteChoicePrefix} || ${chatThreadsTable.id}`))
    .where(
      and(
        eq(alphaSyncStateTable.kind, 'thread'),
        mapEntryIsLive(alphaSyncStateTable.value),
        or(
          isNotNull(chatThreadsTable.deletedAt),
          sql`${chatThreadsTable.title} IS NOT json_extract(${alphaSyncStateTable.value}, '$.title')`,
        ),
      ),
    )
    .limit(limit + 1)

  const hasMore = [unsynced, deletedMessages, changedThreads].some((rows) => rows.length > limit)
  const changed = changedThreads.slice(0, limit).map(
    ({ deleteChoice: choice, ...row }): LocalThread => ({
      ...toLocalThread(row),
      deleteChoice: choice === 'everywhere' || choice === 'here-only' ? choice : null,
    }),
  )
  const deleted = deletedMessages.slice(0, limit)
  const messages = [...unsynced.slice(0, limit), ...deleted.map(({ mappedThreadId: _, ...row }) => row)].map(
    toLocalMessage,
  )
  const known = new Set(changed.map((t) => t.id))
  // The chat a deleted message was in is read too: whether that whole chat was deleted decides
  // whether the message's delete is sent.
  const threadIds = [...messages.map((m) => m.threadId), ...deleted.map((m) => m.mappedThreadId)]
  const parentIds = [...new Set(threadIds.flatMap((id) => (id && !known.has(id) ? [id] : [])))]
  const parents = await readThreads(db, parentIds)
  const adopting = new Map<string, Set<string>>()
  for (const m of messages) {
    if (m.provenance && m.threadId) {
      adopting.set(m.threadId, (adopting.get(m.threadId) ?? new Set()).add(m.provenance.conversationId))
    }
  }
  for (const thread of parents) {
    const conversationIds = adopting.get(thread.id)
    if (!conversationIds) {
      continue
    }
    thread.mintedFor = null
    for (const conversationId of conversationIds) {
      if (await isMintedThreadId(thread.id, conversationId)) {
        thread.mintedFor = conversationId
      }
    }
  }
  return { threads: [...changed, ...parents], messages, hasMore }
}
