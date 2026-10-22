/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatMessagesTable } from '@/db/tables'
import { alphaSyncStateTable } from './tables'

/** Most ids bound in one query. */
const chunkSize = 400

/**
 * Which of these chats may hold text from AI Potluck: one with a message that carries
 * `metadata.alpha`, or one this device maps to an AI Potluck conversation (whose title may be
 * AI Potluck's). For a caller that hands a chat's text or title to a model outside that chat's own
 * history, such as the project search tool, which must quote it the way `quoteSyncedTurns` does.
 */
export const readSyncedThreadIds = async (
  db: AnyDrizzleDatabase,
  threadIds: readonly string[],
): Promise<Set<string>> => {
  const synced = new Set<string>()
  const ids = [...new Set(threadIds)]
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    // A row not yet decrypted here holds no readable JSON, so `json_valid` keeps it from failing the query.
    const withSyncedMessage = await db
      .selectDistinct({ id: chatMessagesTable.chatThreadId })
      .from(chatMessagesTable)
      .where(
        and(
          inArray(chatMessagesTable.chatThreadId, chunk),
          sql`(CASE WHEN json_valid(${chatMessagesTable.metadata}) THEN json_extract(${chatMessagesTable.metadata}, '$.alpha.conversationId') END) IS NOT NULL`,
        ),
      )
    const mapped = await db
      .select({ id: alphaSyncStateTable.localId })
      .from(alphaSyncStateTable)
      .where(
        and(
          eq(alphaSyncStateTable.kind, 'thread'),
          inArray(alphaSyncStateTable.localId, chunk),
          isNotNull(alphaSyncStateTable.remoteId),
        ),
      )
    for (const row of [...withSyncedMessage, ...mapped]) {
      if (row.id) {
        synced.add(row.id)
      }
    }
  }
  return synced
}
