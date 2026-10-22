/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Inbound conflicts: what a pull does when this device already holds the remote's change in some
// form, and when one event both writes and deletes a conversation.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { updateChatThread } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, modelsTable } from '@/db/tables'
import { applyInbound } from './engine'
import { uuidv7Floor } from './ids'
import { toInbound, type ChangesEventV1 } from './map'
import { clearIdMap, loadIdMap } from './storage'

let modelId = ''

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  modelId = uuidv7()
  await getDb().insert(modelsTable).values({
    id: modelId,
    provider: 'thunderbolt',
    name: 'Test Model',
    model: 'gpt-oss-120b',
    isSystem: 1,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    deletedAt: null,
    url: null,
    defaultHash: null,
  })
})

const ctx = { clientId: 'thunderbolt-test' }
const syncFrom = uuidv7Floor(Date.parse('2026-01-01T00:00:00.000Z'))

const conversation = (
  id: string,
  messages: ChangesEventV1['conversations'][number]['messages'],
  title = 'Bread',
): ChangesEventV1['conversations'][number] => ({
  id,
  clientId: null,
  title,
  createdAt: '2026-10-20T12:00:00.000Z',
  updatedAt: '2026-10-20T12:00:05.000Z',
  messages,
})

const event = (overrides: Partial<ChangesEventV1>): ChangesEventV1 => ({
  v: 1,
  cursor: 'c1',
  conversations: [],
  tombstones: [],
  ...overrides,
})

const question = {
  id: 'm1',
  clientId: null,
  role: 'user' as const,
  content: 'How long to proof?',
  createdAt: '2026-10-20T12:00:01.000Z',
  origin: 'alpha',
}
const answer = { ...question, id: 'm2', role: 'assistant' as const, content: 'About an hour.' }

const pull = async (raw: ChangesEventV1) => {
  const db = getDb()
  const batch = await toInbound(raw, ctx)
  await applyInbound(db, await loadIdMap(db), batch, { syncFrom })
  return batch
}

const threadRow = (id: string) => getDb().select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()

describe('inbound conflicts', () => {
  it('applies a later AI Potluck rename after both sides renamed the chat to the same title', async () => {
    const batch = await pull(event({ conversations: [conversation('conv-1', [question], 'Bread')] }))
    const threadId = batch.threads[0].localId
    // Here the title becomes "Rye" before AI Potluck's own rename to "Rye" is pulled: the person
    // typed the same title, or another connected browser pulled it first and Thunderbolt's sync
    // delivered it here.
    await updateChatThread(getDb(), threadId, { title: 'Rye' })
    await pull(event({ cursor: 'c2', conversations: [conversation('conv-1', [question], 'Rye')] }))
    // Later AI Potluck renames it again.
    await pull(event({ cursor: 'c3', conversations: [conversation('conv-1', [question], 'Sourdough')] }))
    expect((await threadRow(threadId))?.title).toBe('Sourdough')
  })

  it('updates a reply AI Potluck filled in when this device holds the copy another device wrote, untouched', async () => {
    const batch = await pull(
      event({ conversations: [conversation('conv-1', [question, { ...answer, content: 'Thinking…' }])] }),
    )
    const replyId = batch.threads[0].messages[1].localId
    // This browser connects later (or lost its map): it has the row through Thunderbolt's sync, but
    // no map entry for it.
    await clearIdMap(getDb())
    await pull(event({ cursor: 'c2', conversations: [conversation('conv-1', [question, answer])] }))
    const row = await getDb().select().from(chatMessagesTable).where(eq(chatMessagesTable.id, replyId)).get()
    expect(row?.content).toBe('About an hour.')
  })
})

describe('one event with a conversation and its tombstone', () => {
  it('leaves no live chat when an event carries a conversation and its own tombstone', async () => {
    const batch = await pull(
      event({
        conversations: [conversation('conv-9', [question])],
        tombstones: [{ kind: 'conversation', id: 'conv-9', clientId: null, deletedAt: '2026-10-20T13:00:00.000Z' }],
      }),
    )
    const live = await getDb()
      .select()
      .from(chatThreadsTable)
      .where(and(eq(chatThreadsTable.id, batch.threads[0].localId), isNull(chatThreadsTable.deletedAt)))
    expect(live).toHaveLength(0)
  })

  it('removes a known chat when one event adds a message to it and deletes it', async () => {
    const batch = await pull(event({ conversations: [conversation('conv-9', [question])] }))
    const threadId = batch.threads[0].localId
    await pull(
      event({
        cursor: 'c2',
        conversations: [conversation('conv-9', [question, answer])],
        tombstones: [{ kind: 'conversation', id: 'conv-9', clientId: null, deletedAt: '2026-10-20T13:00:00.000Z' }],
      }),
    )
    expect((await threadRow(threadId))?.deletedAt).not.toBeNull()
    const live = await getDb()
      .select()
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.chatThreadId, threadId), isNull(chatMessagesTable.deletedAt)))
    expect(live).toHaveLength(0)
  })

  it('does not write a message the same event deletes', async () => {
    const batch = await pull(
      event({
        conversations: [conversation('conv-9', [question, answer])],
        tombstones: [{ kind: 'message', id: 'm2', clientId: null, deletedAt: '2026-10-20T13:00:00.000Z' }],
      }),
    )
    const rows = await getDb()
      .select()
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.chatThreadId, batch.threads[0].localId), isNull(chatMessagesTable.deletedAt)))
    expect(rows.map((r) => r.content)).toEqual(['How long to proof?'])
  })
})
