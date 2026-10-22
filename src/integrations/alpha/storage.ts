/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { and, eq, inArray, like, or } from 'drizzle-orm'
import { getSettingsRecords, updateSettings } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { nowIso } from '@/lib/utils'
import { applyMapWrites, emptyIdMap, type ChatDeleteChoice, type IdMap, type MapEntry } from './plan'
import { alphaSyncSecretsTable, alphaSyncStateTable } from './tables'

/*
 * The bridge's two local-only tables. Neither syncs through PowerSync nor appears in a data export:
 * the tokens and the id map belong to this device. Local-only tables are views without UPSERT, so
 * every write is select-then-write.
 */

const secretsRowId = 'alpha'

export type AlphaCredentials = {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms, or null when the server did not say. */
  expiresAt: number | null
}

export type AlphaConnection = {
  origin: string
  credentials: AlphaCredentials
  metadata: AuthorizationServerMetadata
}

export type ConnectionState =
  | { status: 'none' }
  /** `signed-out`: AI Potluck refused the refresh token, or the build now points at another server. */
  | { status: 'connected' | 'signed-out'; origin: string }

/** Read the stored connection, or null when this device has no usable tokens. */
export const getAlphaConnection = async (db: AnyDrizzleDatabase): Promise<AlphaConnection | null> => {
  const row = await db.select().from(alphaSyncSecretsTable).where(eq(alphaSyncSecretsTable.id, secretsRowId)).get()
  if (!row?.origin || !row.credentials || !row.metadata) {
    return null
  }
  return {
    origin: row.origin,
    credentials: JSON.parse(row.credentials) as AlphaCredentials,
    metadata: JSON.parse(row.metadata) as AuthorizationServerMetadata,
  }
}

/** Whether this device is connected to `configuredOrigin`, signed out of it, or neither. */
export const getConnectionState = async (
  db: AnyDrizzleDatabase,
  configuredOrigin: string,
): Promise<ConnectionState> => {
  const row = await db.select().from(alphaSyncSecretsTable).where(eq(alphaSyncSecretsTable.id, secretsRowId)).get()
  if (!row?.origin) {
    return { status: 'none' }
  }
  const usable = row.credentials && row.metadata && row.origin === configuredOrigin
  return { status: usable ? 'connected' : 'signed-out', origin: row.origin }
}

const writeSecretsRow = async (
  db: AnyDrizzleDatabase,
  values: Omit<typeof alphaSyncSecretsTable.$inferInsert, 'id'>,
) => {
  const existing = await db
    .select({ id: alphaSyncSecretsTable.id })
    .from(alphaSyncSecretsTable)
    .where(eq(alphaSyncSecretsTable.id, secretsRowId))
    .get()
  if (existing) {
    await db.update(alphaSyncSecretsTable).set(values).where(eq(alphaSyncSecretsTable.id, secretsRowId))
  } else {
    await db.insert(alphaSyncSecretsTable).values({ id: secretsRowId, ...values })
  }
}

export const saveAlphaConnection = (db: AnyDrizzleDatabase, connection: AlphaConnection): Promise<void> =>
  writeSecretsRow(db, {
    origin: connection.origin,
    credentials: JSON.stringify(connection.credentials),
    metadata: JSON.stringify(connection.metadata),
  })

/** Drop the tokens but remember the server, so the card can say this device was signed out. */
export const forgetAlphaCredentials = (db: AnyDrizzleDatabase): Promise<void> =>
  db.update(alphaSyncSecretsTable).set({ credentials: null }).where(eq(alphaSyncSecretsTable.id, secretsRowId))

export const deleteAlphaConnection = (db: AnyDrizzleDatabase): Promise<void> =>
  db.delete(alphaSyncSecretsTable).where(eq(alphaSyncSecretsTable.id, secretsRowId))

/** Bookkeeping rows in `alpha_sync_state` beside the id map. */
export const metaKeys = {
  /** The change-stream cursor. */
  cursor: 'meta:cursor',
  /** Epoch ms of the first connect: threads started before it are not uploaded. */
  syncFrom: 'meta:syncFrom',
  /** The server the id map belongs to. */
  origin: 'meta:origin',
  /**
   * The cursor just before the first event this device skipped since the last Retry ('' for the
   * stream's start). Retry reads the stream again from there.
   */
  replayFrom: 'meta:replayFrom',
  /** What this device has taken in from the remote in the current day ({@link InboundUse}). */
  inboundUse: 'meta:inboundUse',
} as const

type MetaKey = (typeof metaKeys)[keyof typeof metaKeys]

/** Rows `delete-choice:<thread id>`: how the person chose to delete a synced chat on this device. */
export const chatDeleteChoicePrefix = 'delete-choice:'

const writeStateRow = async (
  db: AnyDrizzleDatabase,
  id: string,
  values: Omit<typeof alphaSyncStateTable.$inferInsert, 'id'>,
): Promise<void> => {
  const existing = await db
    .select({ id: alphaSyncStateTable.id })
    .from(alphaSyncStateTable)
    .where(eq(alphaSyncStateTable.id, id))
    .get()
  if (existing) {
    await db.update(alphaSyncStateTable).set(values).where(eq(alphaSyncStateTable.id, id))
  } else {
    await db.insert(alphaSyncStateTable).values({ id, ...values })
  }
}

export const getMeta = async (db: AnyDrizzleDatabase, key: MetaKey): Promise<string | null> => {
  const row = await db.select().from(alphaSyncStateTable).where(eq(alphaSyncStateTable.id, key)).get()
  return row?.value ?? null
}

export const setMeta = (db: AnyDrizzleDatabase, key: MetaKey, value: string): Promise<void> =>
  writeStateRow(db, key, { kind: 'meta', localId: null, remoteId: null, source: null, value, updatedAt: nowIso() })

export const deleteMeta = (db: AnyDrizzleDatabase, keys: MetaKey[]): Promise<void> =>
  db.delete(alphaSyncStateTable).where(inArray(alphaSyncStateTable.id, keys))

/**
 * The account's sync window, kept in Thunderbolt's own settings so it syncs (encrypted) to every
 * device: when the first of the account's devices connected to `origin`. A device that connects
 * later adopts it, so all of them sync the same chats. Nothing deletes it: a device that connects
 * after every other one disconnected still syncs the chats synced before.
 */
const sharedSyncFromKey = 'alpha_sync_from'

export const getSharedSyncFrom = async (db: AnyDrizzleDatabase, origin: string): Promise<number | null> => {
  const [row] = await getSettingsRecords(db, [sharedSyncFromKey])
  try {
    const value = JSON.parse(row?.value ?? 'null') as { origin?: unknown; from?: unknown } | null
    return value?.origin === origin && typeof value.from === 'number' && value.from > 0 ? value.from : null
  } catch {
    return null
  }
}

export const setSharedSyncFrom = (db: AnyDrizzleDatabase, origin: string, from: number): Promise<void> =>
  updateSettings(db, { [sharedSyncFromKey]: JSON.stringify({ origin, from }) })

/** Forget every mapped row: used when the connection moves to a different server. */
export const clearIdMap = (db: AnyDrizzleDatabase): Promise<void> =>
  db.delete(alphaSyncStateTable).where(inArray(alphaSyncStateTable.kind, ['thread', 'message']))

/**
 * Forget the records of conversations and events the stream skipped (`skipped:` and
 * `skipped-event:` thread entries, see `plan.ts`). Used on Disconnect, which reads the stream again
 * from its start on the next connect, so whatever is still skipped is recorded again.
 */
export const clearSkipRecords = (db: AnyDrizzleDatabase): Promise<void> =>
  db
    .delete(alphaSyncStateTable)
    .where(
      and(
        eq(alphaSyncStateTable.kind, 'thread'),
        or(like(alphaSyncStateTable.localId, 'skipped:%'), like(alphaSyncStateTable.localId, 'skipped-event:%')),
      ),
    )

const stateRowId = (entry: Pick<MapEntry, 'kind' | 'localId'>) => `${entry.kind}:${entry.localId}`

type StoredValue = Pick<
  MapEntry,
  'title' | 'remoteTitles' | 'threadLocalId' | 'deleted' | 'dropped' | 'hash' | 'rejected'
>

/** Load the id map from `alpha_sync_state`. */
export const loadIdMap = async (db: AnyDrizzleDatabase): Promise<IdMap> => {
  const map = emptyIdMap()
  const rows = await db
    .select()
    .from(alphaSyncStateTable)
    .where(inArray(alphaSyncStateTable.kind, ['thread', 'message']))
  const entries: MapEntry[] = []
  for (const row of rows) {
    if (!row.localId || (row.kind !== 'thread' && row.kind !== 'message')) {
      continue
    }
    const value = row.value ? (JSON.parse(row.value) as StoredValue) : {}
    entries.push({
      kind: row.kind,
      localId: row.localId,
      remoteId: row.remoteId,
      source: row.source === 'local' ? 'local' : 'remote',
      title: value.title,
      remoteTitles: value.remoteTitles,
      threadLocalId: value.threadLocalId,
      deleted: value.deleted,
      dropped: value.dropped,
      hash: value.hash,
      rejected: value.rejected,
    })
  }
  applyMapWrites(map, entries)
  return map
}

/** Split `items` into runs short enough for one `IN (…)` list. */
export const chunked = <T>(items: T[], size = 400): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/** Persist map entries; the last write for a row wins. */
export const saveMapEntries = async (db: AnyDrizzleDatabase, entries: MapEntry[]): Promise<void> => {
  if (entries.length === 0) {
    return
  }
  const latest = new Map(entries.map((e) => [stateRowId(e), e]))
  const updatedAt = nowIso()
  const toRow = (entry: MapEntry) => ({
    kind: entry.kind,
    localId: entry.localId,
    remoteId: entry.remoteId,
    source: entry.source,
    value: JSON.stringify({
      title: entry.title,
      remoteTitles: entry.remoteTitles,
      threadLocalId: entry.threadLocalId,
      deleted: entry.deleted,
      dropped: entry.dropped,
      hash: entry.hash,
      rejected: entry.rejected,
    } satisfies StoredValue),
    updatedAt,
  })
  await db.transaction(async (tx) => {
    for (const ids of chunked([...latest.keys()])) {
      const existing = new Set(
        (
          await tx
            .select({ id: alphaSyncStateTable.id })
            .from(alphaSyncStateTable)
            .where(inArray(alphaSyncStateTable.id, ids))
        ).map((r) => r.id),
      )
      const inserts = ids.filter((id) => !existing.has(id))
      if (inserts.length) {
        await tx.insert(alphaSyncStateTable).values(inserts.map((id) => ({ id, ...toRow(latest.get(id) as MapEntry) })))
      }
      for (const id of ids.filter((i) => existing.has(i))) {
        await tx
          .update(alphaSyncStateTable)
          .set(toRow(latest.get(id) as MapEntry))
          .where(eq(alphaSyncStateTable.id, id))
      }
    }
  })
}

export const deleteMapEntries = async (db: AnyDrizzleDatabase, entries: MapEntry[]): Promise<void> => {
  for (const ids of chunked(entries.map(stateRowId))) {
    await db.delete(alphaSyncStateTable).where(inArray(alphaSyncStateTable.id, ids))
  }
}

/**
 * Record how the person chose to delete a synced chat, before the chat's own delete is written, so
 * the push pass that the delete wakes reads both. Local to this device, like the id map.
 */
export const recordChatDeleteChoice = (db: AnyDrizzleDatabase, threadId: string, choice: ChatDeleteChoice) =>
  writeStateRow(db, `${chatDeleteChoicePrefix}${threadId}`, {
    kind: 'delete-choice',
    localId: threadId,
    remoteId: null,
    source: null,
    value: choice,
    updatedAt: nowIso(),
  })

/** Whether this device syncs the chat with AI Potluck now: it is connected and the chat is mapped. */
export const isChatSyncedToAlpha = async (
  db: AnyDrizzleDatabase,
  threadId: string,
  configuredOrigin: string,
): Promise<boolean> => {
  if ((await getConnectionState(db, configuredOrigin)).status !== 'connected') {
    return false
  }
  const row = await db
    .select()
    .from(alphaSyncStateTable)
    .where(eq(alphaSyncStateTable.id, stateRowId({ kind: 'thread', localId: threadId })))
    .get()
  if (!row?.remoteId) {
    return false
  }
  const value = row.value ? (JSON.parse(row.value) as StoredValue) : {}
  return value.deleted !== true
}
