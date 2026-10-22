/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  deleteChatMessageAndDescendants,
  deleteChatThread,
  restoreChatMessages,
  saveMessagesWithContextUpdate,
} from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, modelsTable } from '@/db/tables'
import type { ThunderboltUIMessage } from '@/types'
import { applyInbound } from './engine'
import { uuidv7Floor } from './ids'
import { readOutboundCandidates } from './local-reads'
import { toInbound, type ChangesEventV1 } from './map'
import { mapWritesForAck, planOutbound } from './plan'
import { loadIdMap, recordChatDeleteChoice, saveMapEntries } from './storage'

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

const event = (
  messages: ChangesEventV1['conversations'][number]['messages'],
  overrides: Partial<ChangesEventV1> = {},
): ChangesEventV1 => ({
  v: 1,
  cursor: 'c1',
  conversations: [
    {
      id: 'conv-1',
      clientId: null,
      title: 'Bread',
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:00:05.000Z',
      messages,
    },
  ],
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

/** Everything created in this test counts as "after connecting". */
const syncFrom = uuidv7Floor(Date.parse('2026-01-01T00:00:00.000Z'))
const settled = {
  isSettled: () => true,
  isStalled: () => false,
  createdAt: () => 'x',
  syncFrom,
  maxContentChars: 100_000,
}

const userMessage = (id: string, text: string): ThunderboltUIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

const pull = async (raw: ChangesEventV1) => {
  const db = getDb()
  const map = await loadIdMap(db)
  const batch = await toInbound(raw, ctx)
  await applyInbound(db, map, batch, { syncFrom })
  return { map, batch }
}

/** A chat's live messages as Thunderbolt shows them: text and parent, in id order. */
const liveMessages = async (threadId: string) =>
  (
    await getDb()
      .select()
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.chatThreadId, threadId), isNull(chatMessagesTable.deletedAt)))
      .orderBy(chatMessagesTable.id)
  ).map((r) => ({ id: r.id, parentId: r.parentId, content: r.content }))

const pendingPush = async () => {
  const db = getDb()
  const map = await loadIdMap(db)
  return planOutbound(await readOutboundCandidates(db, { syncFrom, limit: 1000 }), map, settled).batch
}

describe('deletes in a synced chat', () => {
  it('does not undo a person delete made after another device restored a dropped row', async () => {
    const a1 = { ...answer, id: 'm2', content: 'first answer' }
    const a2 = { ...answer, id: 'm3', content: 'regenerated', createdAt: '2026-10-20T12:00:03.000Z' }
    // This device (B) sees the drop.
    await pull(event([question, a1]))
    await pull(event([question, a2], { cursor: 'c2' }))
    const map = await loadIdMap(getDb())
    const a1Local = [...map.messages.values()].find((e) => e.remoteId === 'm2')!
    expect(a1Local.dropped).toBe(true)
    const threadId = a1Local.threadLocalId!
    // B's tab closes. Device A's bridge restores a1 when AI Potluck switches back; PowerSync brings
    // the restored row to B's database.
    await restoreChatMessages(getDb(), threadId, [
      {
        message: {
          id: a1Local.localId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'first answer' }],
          metadata: { alpha: { conversationId: 'conv-1', messageId: 'm2' } },
        },
        parentId: null,
      },
    ])
    // The person deletes that reply (anywhere); the delete syncs here too.
    await deleteChatMessageAndDescendants(getDb(), a1Local.localId)
    // B opens again and pulls the conversation as it now stands on AI Potluck: a1 on the branch.
    await pull(event([question, a1], { cursor: 'c3' }))
    const live = await liveMessages(threadId)
    expect(live.map((m) => m.content)).not.toContain('first answer')
  })

  /** A chat pulled from AI Potluck, holding a turn the person wrote here that was pushed and acked. */
  const pulledChatWithMyTurn = async () => {
    await pull(event([question, answer]))
    const map0 = await loadIdMap(getDb())
    const threadId = map0.threadsByRemote.get('conv-1')!.localId
    const mine = uuidv7()
    await saveMessagesWithContextUpdate(getDb(), threadId, [userMessage(mine, 'my follow-up')])
    const out = await pendingPush()
    expect(out.messages.map((m) => m.localId)).toEqual([mine])
    const map1 = await loadIdMap(getDb())
    const { mapWrites } = mapWritesForAck(
      out,
      { threads: [], messages: [{ localId: mine, remoteId: 'r-mine' }], rejected: [] },
      map1,
    )
    await saveMapEntries(getDb(), mapWrites)
    return threadId
  }

  it('deleting an AI Potluck chat everywhere sends one delete of the whole conversation, never one per message', async () => {
    const threadId = await pulledChatWithMyTurn()
    await recordChatDeleteChoice(getDb(), threadId, 'everywhere')
    await deleteChatThread(getDb(), threadId)
    const after = await pendingPush()
    expect(after.messages.filter((m) => m.deletedAt)).toEqual([])
    expect(after.threads).toEqual([
      expect.objectContaining({ localId: threadId, remoteId: 'conv-1', deletedAt: expect.any(String) }),
    ])
  })

  it('removing an AI Potluck chat from Thunderbolt only sends nothing, the person’s own turns included', async () => {
    const threadId = await pulledChatWithMyTurn()
    await recordChatDeleteChoice(getDb(), threadId, 'here-only')
    await deleteChatThread(getDb(), threadId)
    const after = await pendingPush()
    expect(after.messages.filter((m) => m.deletedAt)).toEqual([])
    expect(after.threads).toEqual([])
  })
})
