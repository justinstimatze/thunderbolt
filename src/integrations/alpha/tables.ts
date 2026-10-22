/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Local-only: the AI Potluck OAuth grant (origin, tokens, discovered endpoints). Never synced via
 * PowerSync, never exported — a token is per device and the other devices connect on their own.
 */
export const alphaSyncSecretsTable = sqliteTable('alpha_sync_secrets', {
  id: text('id').primaryKey(), // always 'alpha'
  origin: text('origin'),
  credentials: text('credentials'), // JSON: AlphaCredentials
  metadata: text('metadata'), // JSON: the discovered authorization-server metadata
})

/**
 * Local-only: the bridge's bookkeeping. One row per synced thread or message (`thread:<localId>`,
 * `message:<localId>`) mapping it to the remote id, plus `meta:*` rows (cursor, connect time, origin). Kept on Disconnect
 * so a reconnect maps the same rows to the same ids instead of duplicating them.
 */
export const alphaSyncStateTable = sqliteTable('alpha_sync_state', {
  id: text('id').primaryKey(),
  kind: text('kind'), // 'thread' | 'message' | 'meta'
  localId: text('local_id'),
  remoteId: text('remote_id'),
  /** 'remote' when the row came from the provider, 'local' when this app pushed it. */
  source: text('source'),
  /**
   * JSON for map rows: `{ title?, threadLocalId?, deleted?, hash?, rejected? }` (see `MapEntry` in
   * `plan.ts`). The raw value for meta rows.
   */
  value: text('value'),
  updatedAt: text('updated_at'),
})
