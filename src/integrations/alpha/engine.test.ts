/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  deleteAllChatThreads,
  deleteChatMessageAndDescendants,
  deleteChatThread,
  getOrCreateChatThread,
  saveMessagesWithContextUpdate,
  updateChatThread,
} from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, modelsTable } from '@/db/tables'
import { HttpError } from '@/lib/http'
import type { ThunderboltUIMessage } from '@/types'
import {
  applyInbound,
  applyInboundWithinBudget,
  defaultChunkLimits,
  planInboundFromDb,
  runSyncEngine,
  writeInbound,
  type EngineControls,
  type EngineStatus,
  type InboundBudget,
} from './engine'
import { beginSyncState, disconnectAlpha } from './connect'
import { SyncError } from './errors'
import { uuidv7At, uuidv7Floor, uuidv7Ms } from './ids'
import { partsText, readOutboundCandidates } from './local-reads'
import { fitsPushLimits, toInbound, toPushBody, type ChangesEventV1 } from './map'
import { getClock } from '@/testing-library'
import { chunkBatch, mapWritesForAck, planOutbound } from './plan'
import type { ExternalSyncProvider, InboundBatch, OutboundBatch, PushAck } from './provider'
import {
  clearIdMap,
  deleteMeta,
  getMeta,
  isChatSyncedToAlpha,
  loadIdMap,
  metaKeys,
  recordChatDeleteChoice,
  saveAlphaConnection,
  saveMapEntries,
} from './storage'

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

/** Start a chat the way Thunderbolt does, with one user message. */
const startChat = async (text: string, isEncrypted: 0 | 1 = 0) => {
  const threadId = uuidv7()
  const messageId = uuidv7()
  await getOrCreateChatThread(getDb(), threadId, modelId, { isEncrypted })
  await saveMessagesWithContextUpdate(getDb(), threadId, [userMessage(messageId, text)])
  return { threadId, messageId }
}

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

const tombstone = (id: string) => ({
  kind: 'conversation' as const,
  id,
  clientId: null,
  deletedAt: '2026-10-20T13:00:00.000Z',
})

/** A conversation new to this device: applying it needs a model to create its chat with. */
const newConversation = {
  ...event([]).conversations[0],
  id: 'conv-2',
  title: 'New',
  messages: [{ ...question, id: 'n1' }],
}

/**
 * Apply `raw` with no model to create chats with, so it fails partway, then put the model back.
 * The cursor was not saved, so the caller replays the batch.
 */
const failThenReplay = async (
  raw: ChangesEventV1,
  afterFailure?: (map: Awaited<ReturnType<typeof loadIdMap>>) => void | Promise<void>,
) => {
  const models = await getDb().select().from(modelsTable)
  await getDb().delete(modelsTable)
  expect(await pull(raw).catch((e: unknown) => e)).toMatchObject({ kind: 'paused', code: 'no-model' })
  await afterFailure?.(await loadIdMap(getDb()))
  await getDb().insert(modelsTable).values(models)
  return pull(raw)
}

describe('applyInbound', () => {
  it('writes a pulled conversation through the DAL with its provenance, and then has nothing to push back', async () => {
    const { batch } = await pull(event([question, answer]))
    const threadId = batch.threads[0].localId
    const thread = await getDb().select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
    expect(thread?.title).toBe('Bread')
    const rows = await getDb().select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, threadId))
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1].metadata).toMatchObject({ alpha: { conversationId: 'conv-1', messageId: 'm2' } })
    expect(await pendingPush()).toEqual({ threads: [], messages: [] })
  })

  it('updates a pulled reply when AI Potluck changes its text', async () => {
    const { batch } = await pull(event([question, { ...answer, content: 'Thinking…' }]))
    await pull(event([question, { ...answer, content: 'About an hour.' }]))
    const row = await getDb()
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.id, batch.threads[0].messages[1].localId))
      .get()
    expect(row?.parts).toEqual([{ type: 'text', text: 'About an hour.' }])
  })

  it('deletes a pulled thread on a tombstone, but only unmaps a chat the person wrote here', async () => {
    const { batch } = await pull(event([question]))
    const mine = await startChat('my own chat')
    await saveMapEntries(getDb(), [
      { kind: 'thread', localId: mine.threadId, remoteId: 'conv-mine', source: 'local', title: null },
    ])
    await pull(
      event([], {
        conversations: [],
        tombstones: [
          { kind: 'conversation', id: 'conv-1', clientId: null, deletedAt: '2026-10-20T13:00:00.000Z' },
          { kind: 'conversation', id: 'conv-mine', clientId: null, deletedAt: '2026-10-20T13:00:00.000Z' },
        ],
      }),
    )
    const theirs = await getDb()
      .select()
      .from(chatThreadsTable)
      .where(eq(chatThreadsTable.id, batch.threads[0].localId))
      .get()
    const own = await getDb().select().from(chatThreadsTable).where(eq(chatThreadsTable.id, mine.threadId)).get()
    expect(theirs?.deletedAt).not.toBeNull()
    expect(own?.deletedAt).toBeNull()
  })

  it('never deletes an AI Potluck conversation when its chat is deleted here, one at a time or all at once', async () => {
    const db = getDb()
    const { batch } = await pull(
      event([question], {
        conversations: ['conv-1', 'conv-2', 'conv-3'].map((id) => ({
          ...event([]).conversations[0],
          id,
          messages: [{ ...question, id: `${id}-m1` }],
        })),
      }),
    )
    // The person writes a turn in each chat, and both are pushed.
    const mine = [uuidv7(), uuidv7()]
    await saveMessagesWithContextUpdate(db, batch.threads[0].localId, [userMessage(mine[0], 'mine in conv-1')])
    await saveMessagesWithContextUpdate(db, batch.threads[1].localId, [userMessage(mine[1], 'mine in conv-2')])
    const out = await pendingPush()
    expect(out.messages.map((m) => m.localId)).toEqual(mine)
    const ack = { threads: [], messages: mine.map((localId, i) => ({ localId, remoteId: `r-${i}` })), rejected: [] }
    await saveMapEntries(db, mapWritesForAck(out, ack, await loadIdMap(db)).mapWrites)

    await deleteChatThread(db, batch.threads[0].localId)
    expect(await pendingPush()).toMatchObject({ threads: [], messages: [] })
    await deleteAllChatThreads(db)
    expect(await pendingPush()).toMatchObject({ threads: [], messages: [] })
  })

  it('sends no delete for the person’s turns in AI Potluck chats deleted all at once, even a page at a time', async () => {
    const db = getDb()
    // Three empty conversations, then one with a turn: the person's turn in the last chat is the
    // second deleted message read, before that chat is.
    const { batch } = await pull(
      event([question], {
        conversations: ['conv-1', 'conv-2', 'conv-3', 'conv-4'].map((id) => ({
          ...event([]).conversations[0],
          id,
          messages: id === 'conv-4' ? [{ ...question, id: 'conv-4-m1' }] : [],
        })),
      }),
    )
    const last = batch.threads.find((t) => t.remoteId === 'conv-4')!
    const mine = [uuidv7()]
    await saveMessagesWithContextUpdate(db, last.localId, [userMessage(mine[0], 'mine')])
    const out = await pendingPush()
    const ack = { threads: [], messages: mine.map((localId, i) => ({ localId, remoteId: `r-${i}` })), rejected: [] }
    await saveMapEntries(db, mapWritesForAck(out, ack, await loadIdMap(db)).mapWrites)

    await deleteAllChatThreads(db)
    // One row of each kind per pass, so a deleted message can arrive in a pass that did not read its chat.
    for (let pass = 0; pass < 12; pass++) {
      const plan = planOutbound(await readOutboundCandidates(db, { syncFrom, limit: 1 }), await loadIdMap(db), settled)
      expect(plan.batch).toMatchObject({ threads: [], messages: [] })
      await saveMapEntries(db, plan.mapWrites)
    }
  })

  it('pauses instead of half-writing a pulled chat when no model is available', async () => {
    await getDb().delete(modelsTable)
    const error = await pull(event([question])).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'paused', code: 'no-model' })
  })

  it('stores a reply inserted between two pulled messages under the one before it, not the newest', async () => {
    const later = { ...answer, id: 'm3', createdAt: '2026-10-20T12:00:03.000Z' }
    await pull(event([question, later]))
    const between = { ...answer, id: 'm2', createdAt: '2026-10-20T12:00:02.000Z' }
    const { batch } = await pull(event([question, between, later]))
    const rows = await getDb()
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatThreadId, batch.threads[0].localId))
      .orderBy(chatMessagesTable.id)
    expect(rows.map((r) => [r.content ?? r.parts, r.parentId])).toEqual([
      [expect.anything(), null],
      [expect.anything(), rows[0].id],
      [expect.anything(), rows[0].id],
    ])
  })

  it('records nothing for a batch that fails partway, and writes all of it when the batch is replayed', async () => {
    const { batch } = await failThenReplay(event([question, answer]), (map) =>
      expect(map.messagesByRemote.size).toBe(0),
    )
    const rows = await getDb()
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatThreadId, batch.threads[0].localId))
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(rows[1].parentId).toBe(rows[0].id)
  })

  it('deletes a pulled chat when a batch that failed after planning its tombstone is replayed', async () => {
    const { batch } = await pull(event([question]))
    await failThenReplay(
      event([], { cursor: 'c2', conversations: [newConversation], tombstones: [tombstone('conv-1')] }),
    )
    const thread = await getDb()
      .select()
      .from(chatThreadsTable)
      .where(eq(chatThreadsTable.id, batch.threads[0].localId))
      .get()
    expect(thread?.deletedAt).not.toBeNull()
  })

  it('applies a rename when a batch that failed partway is replayed, and never pushes the old title back', async () => {
    const { batch } = await pull(event([question]))
    const renamed = { ...event([question]).conversations[0], title: 'Rye' }
    await failThenReplay(event([], { cursor: 'c2', conversations: [renamed, newConversation] }))
    const thread = await getDb()
      .select()
      .from(chatThreadsTable)
      .where(eq(chatThreadsTable.id, batch.threads[0].localId))
      .get()
    expect(thread?.title).toBe('Rye')
    expect((await pendingPush()).threads).toEqual([])
  })

  it('keeps the chat and the person’s message when they reply between a conversation delete being planned and carried out', async () => {
    const db = getDb()
    const { batch } = await pull(event([question, answer]))
    const threadId = batch.threads[0].localId
    const map = await loadIdMap(db)
    const plan = await planInboundFromDb(
      db,
      map,
      await toInbound(event([], { cursor: 'c2', conversations: [], tombstones: [tombstone('conv-1')] }), ctx),
      { syncFrom },
    )
    const mine = uuidv7()
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(mine, 'one more thing')])
    await writeInbound(db, map, plan)
    const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
    const rows = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.chatThreadId, threadId))
    expect(thread?.deletedAt).toBeNull()
    expect(rows.filter((r) => r.deletedAt === null).map((r) => r.id)).toEqual([mine])
  })
})

describe('a push that reached AI Potluck but whose answer was lost', () => {
  const echo = (id: string, clientId: string, content: string) => ({
    ...question,
    id,
    clientId,
    origin: ctx.clientId,
    content,
    createdAt: new Date(Date.now() + 1000).toISOString(),
  })
  const echoed = (threadId: string, messages: ReturnType<typeof echo>[]) =>
    event([], {
      conversations: [
        {
          ...event([]).conversations[0],
          clientId: threadId,
          origin: ctx.clientId,
          createdAt: messages[0].createdAt,
          messages,
        },
      ],
    })

  it('sends the delete of a message deleted here before its echo arrived', async () => {
    const db = getDb()
    const { threadId, messageId: keep } = await startChat('keep me')
    const gone = uuidv7()
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(gone, 'delete me')])
    await deleteChatMessageAndDescendants(db, gone)

    await pull(echoed(threadId, [echo('r-keep', keep, 'keep me'), echo('r-gone', gone, 'delete me')]))

    expect((await loadIdMap(db)).messages.get(keep)?.remoteId).toBe('r-keep')
    const deletes = (await pendingPush()).messages.filter((m) => m.deletedAt)
    expect(deletes.map((m) => [m.remoteId, m.text])).toEqual([['r-gone', '']])
  })

  it('sends the delete of a chat deleted here before its echo arrived', async () => {
    const { threadId, messageId } = await startChat('a chat I then deleted')
    await deleteChatThread(getDb(), threadId)

    await pull(echoed(threadId, [echo('r-1', messageId, 'a chat I then deleted')]))

    const { threads } = await pendingPush()
    expect(threads.map((t) => [t.remoteId, t.title, Boolean(t.deletedAt)])).toEqual([['conv-1', null, true]])
  })
})

describe('a regeneration on AI Potluck', () => {
  const regenerated = { ...answer, id: 'm3', content: 'Closer to two hours.', createdAt: '2026-10-20T12:00:03.000Z' }

  it('brings a reply back when AI Potluck switches back to its branch, and pushes nothing either way', async () => {
    const { batch } = await pull(event([question, answer]))
    const threadId = batch.threads[0].localId
    await pull(event([question, regenerated], { cursor: 'c2' }))
    expect((await liveMessages(threadId)).map((m) => m.content)).toEqual(['How long to proof?', 'Closer to two hours.'])
    expect(await pendingPush()).toEqual({ threads: [], messages: [] })

    await pull(event([question, answer], { cursor: 'c3' }))
    const [q, a] = await liveMessages(threadId)
    expect([q.content, a.content]).toEqual(['How long to proof?', 'About an hour.'])
    expect(a.parentId).toBe(q.id)
    expect(await pendingPush()).toEqual({ threads: [], messages: [] })
  })

  it('still brings a reply back when the batch that dropped it failed partway, a push pass ran, and the batch was replayed', async () => {
    const { batch } = await pull(event([question, answer]))
    const threadId = batch.threads[0].localId
    const regenerate = event([], {
      cursor: 'c2',
      conversations: [event([question, regenerated]).conversations[0], newConversation],
    })
    await failThenReplay(regenerate, async () => {
      const db = getDb()
      const plan = planOutbound(
        await readOutboundCandidates(db, { syncFrom, limit: 1000 }),
        await loadIdMap(db),
        settled,
      )
      expect(plan.batch).toEqual({ threads: [], messages: [] })
      await saveMapEntries(db, plan.mapWrites)
    })
    await pull(event([question, answer], { cursor: 'c3' }))
    expect((await liveMessages(threadId)).map((m) => m.content)).toEqual(['How long to proof?', 'About an hour.'])
  })

  it('brings back a reply another browser dropped, when that delete reached this one before the regeneration did', async () => {
    const db = getDb()
    const { batch } = await pull(event([question, answer]))
    const threadId = batch.threads[0].localId
    // The other browser applies the regeneration; only its row writes reach this one, not its map.
    const otherMap = await loadIdMap(db)
    const theirs = await planInboundFromDb(
      db,
      otherMap,
      await toInbound(event([question, regenerated], { cursor: 'c2' }), ctx),
      {
        syncFrom,
      },
    )
    await writeInbound(db, otherMap, { ...theirs, mapWrites: [] })
    const pushPass = planOutbound(
      await readOutboundCandidates(db, { syncFrom, limit: 1000 }),
      await loadIdMap(db),
      settled,
    )
    expect(pushPass.batch).toEqual({ threads: [], messages: [] })
    await saveMapEntries(db, pushPass.mapWrites)

    await pull(event([question, regenerated], { cursor: 'c2' }))
    await pull(event([question, answer], { cursor: 'c3' }))
    expect((await liveMessages(threadId)).map((m) => m.content)).toEqual(['How long to proof?', 'About an hour.'])
  })

  it('never brings back a pulled reply the person deleted here', async () => {
    const { batch } = await pull(event([question, answer]))
    const threadId = batch.threads[0].localId
    await deleteChatMessageAndDescendants(getDb(), batch.threads[0].messages[1].localId)
    await pull(event([question, regenerated], { cursor: 'c2' }))
    await pull(event([question, answer], { cursor: 'c3' }))
    expect((await liveMessages(threadId)).map((m) => m.content)).toEqual(['How long to proof?'])
  })
})

describe('the id map across a reload', () => {
  it('still knows the titles AI Potluck sent, so a late copy of an earlier one is not pushed back as a rename', async () => {
    const { batch } = await pull(event([question]))
    await pull(event([], { cursor: 'c2', conversations: [{ ...event([question]).conversations[0], title: 'Rye' }] }))
    // Another device wrote AI Potluck's first title, and its copy reaches this one late.
    await updateChatThread(getDb(), batch.threads[0].localId, { title: 'Bread' })
    expect(await pendingPush()).toEqual({ threads: [], messages: [] })
  })
})

describe('a back-dated turn in a chat the person started', () => {
  it('lets a second device adopt the chat as the person’s own, so an AI Potluck delete cannot remove it', async () => {
    const db = getDb()
    // Device A: the person starts a chat and it is pushed.
    const threadId = uuidv7()
    await getOrCreateChatThread(db, threadId, modelId, { isEncrypted: 0 })
    await getClock().tickAsync(5)
    const messageId = uuidv7()
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(messageId, 'my question')])
    await saveMapEntries(db, [
      { kind: 'thread', localId: threadId, remoteId: 'conv-1', source: 'local', title: null },
      { kind: 'message', localId: messageId, remoteId: 'm-mine', source: 'local', threadLocalId: threadId },
    ])
    // AI Potluck sends it back with a turn dated 1970 and one dated now.
    const now = new Date(Date.now()).toISOString()
    const backDated = {
      ...event([]).conversations[0],
      clientId: threadId,
      origin: ctx.clientId,
      createdAt: '1970-01-01T00:00:00.000Z',
      messages: [
        { ...question, id: 'injected', content: 'from 1970', createdAt: '1970-01-01T00:00:00.000Z' },
        {
          ...question,
          id: 'm-mine',
          clientId: messageId,
          origin: ctx.clientId,
          content: 'my question',
          createdAt: now,
        },
        { ...answer, id: 'reply', createdAt: now },
      ],
    }
    await pull(event([], { conversations: [backDated] }))
    // Device B holds the same rows through Thunderbolt's sync, and no map of its own.
    await clearIdMap(db)
    const map = await loadIdMap(db)
    const plan = planOutbound(await readOutboundCandidates(db, { syncFrom, limit: 1000 }), map, settled)
    expect(plan.mapWrites).toContainEqual(
      expect.objectContaining({ kind: 'thread', localId: threadId, remoteId: 'conv-1', source: 'local' }),
    )
    await saveMapEntries(db, plan.mapWrites)
    await pull(
      event([], {
        conversations: [],
        tombstones: [{ kind: 'conversation', id: 'conv-1', clientId: null, deletedAt: now }],
      }),
    )
    const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
    const mine = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId)).get()
    expect(thread?.deletedAt).toBeNull()
    expect(mine?.deletedAt).toBeNull()
  })

  it('dates a turn added to a linked chat no earlier than the chat began, whatever start AI Potluck claims for it', async () => {
    const db = getDb()
    const threadId = uuidv7Floor(Date.parse('2025-10-01T00:00:00.000Z')).replace(/-8000-/, '-8abc-')
    await getOrCreateChatThread(db, threadId, modelId, { isEncrypted: 0 })
    await saveMapEntries(db, [{ kind: 'thread', localId: threadId, remoteId: 'conv-1', source: 'local', title: null }])
    // AI Potluck re-sends the linked conversation under an earlier client id, with a turn dated 2020.
    const backDated = {
      ...event([]).conversations[0],
      clientId: uuidv7Floor(Date.parse('2020-01-01T00:00:00.000Z')),
      origin: ctx.clientId,
      createdAt: '2020-01-01T00:00:00.000Z',
      messages: [{ ...question, id: 'injected', createdAt: '2020-01-01T00:00:00.000Z' }],
    }
    const batch = await toInbound(event([], { conversations: [backDated] }), ctx)
    const plan = await planInboundFromDb(db, await loadIdMap(db), batch, { syncFrom })
    const inserted = plan.insertMessages.flatMap((g) =>
      g.messages.map((m) => ({ ...m, threadLocalId: g.threadLocalId })),
    )
    expect(inserted.map((m) => m.threadLocalId)).toEqual([threadId])
    expect(uuidv7Ms(inserted[0].localId)).toBeGreaterThanOrEqual(uuidv7Ms(threadId) as number)
  })
})

describe('partsText', () => {
  it('counts a reply as still being written while a tool call is pending or its result is not answered yet', () => {
    const text = { type: 'text', text: 'Let me search.', state: 'done' }
    const tool = (state: string) => ({ type: 'tool-search', toolCallId: 'c1', state })
    expect(partsText([text, tool('input-streaming')], null).isStreaming).toBe(true)
    expect(partsText([text, tool('input-available')], null).isStreaming).toBe(true)
    expect(partsText([text, tool('output-available')], null).isStreaming).toBe(true)
    expect(partsText([text, tool('output-available'), { type: 'step-start' }], null).isStreaming).toBe(true)
    const finished = partsText(
      [text, tool('output-available'), { type: 'step-start' }, { ...text, text: ' Found it.' }],
      null,
    )
    expect(finished).toEqual({ text: 'Let me search. Found it.', isStreaming: false })
  })
})

describe('readOutboundCandidates', () => {
  it('reads only rows that may need syncing, never chats from before connecting or private ones', async () => {
    const before = await startChat('old history')
    const db = getDb()
    const floor = uuidv7Floor(Date.now() + 1)
    getClock().tick(5)
    const fresh = await startChat('new chat')
    await startChat('private', 1)
    const candidates = await readOutboundCandidates(db, { syncFrom: floor, limit: 1000 })
    expect(candidates.messages.map((m) => m.id)).toEqual([fresh.messageId])
    expect(candidates.threads.map((t) => t.id)).toEqual([fresh.threadId])
    expect(candidates.messages.some((m) => m.threadId === before.threadId)).toBe(false)
  })

  it('stops reading a row once it is mapped, and reads it again only for a rename or delete', async () => {
    const chat = await startChat('hello')
    const db = getDb()
    const [thread] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, chat.threadId))
    // After an accepted push the map records the title that was sent.
    await saveMapEntries(db, [
      { kind: 'thread', localId: chat.threadId, remoteId: 'conv-1', source: 'local', title: thread.title },
      { kind: 'message', localId: chat.messageId, remoteId: 'm1', source: 'local', threadLocalId: chat.threadId },
    ])
    expect(await readOutboundCandidates(db, { syncFrom, limit: 1000 })).toMatchObject({ threads: [], messages: [] })
    await updateChatThread(db, chat.threadId, { title: 'Renamed' })
    const renamed = await readOutboundCandidates(db, { syncFrom, limit: 1000 })
    expect(renamed.threads.map((t) => t.title)).toEqual(['Renamed'])
  })

  it('reads every unsynced turn of a synced chat, even one written before a later sync window, so the remote copy has no gap', async () => {
    const db = getDb()
    const t0 = Date.parse('2026-10-20T10:00:00.000Z')
    const hour = 3_600_000
    const threadId = uuidv7At(t0, 'thread')
    const synced = uuidv7At(t0 + 1000, 'm0')
    const writtenWhileDisconnected = uuidv7At(t0 + 2 * hour, 'm1')
    const writtenAfterReconnect = uuidv7At(t0 + 3 * hour + 60_000, 'm2')
    await getOrCreateChatThread(db, threadId, modelId, { isEncrypted: 0 })
    const [thread] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId))
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(synced, 'first, synced')])
    await saveMapEntries(db, [
      { kind: 'thread', localId: threadId, remoteId: 'conv-r', source: 'local', title: thread.title },
      { kind: 'message', localId: synced, remoteId: 'msg-r0', source: 'local', threadLocalId: threadId, hash: 'x' },
    ])
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(writtenWhileDisconnected, 'second, offline')])
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(writtenAfterReconnect, 'third, after reconnect')])
    // A window that opened after the chat synced, as a reconnect with no window left would open.
    const laterWindow = uuidv7Floor(t0 + 3 * hour)
    const candidates = await readOutboundCandidates(db, { syncFrom: laterWindow, limit: 1000 })
    const plan = planOutbound(candidates, await loadIdMap(db), { ...settled, syncFrom: laterWindow })
    expect(plan.batch.messages.map((m) => m.localId)).toEqual([writtenWhileDisconnected, writtenAfterReconnect])
  })

  it('still reads nothing from a chat not synced yet that began before the window', async () => {
    const db = getDb()
    const t0 = Date.parse('2026-10-20T10:00:00.000Z')
    const threadId = uuidv7At(t0, 'old-thread')
    await getOrCreateChatThread(db, threadId, modelId, { isEncrypted: 0 })
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(uuidv7At(t0 + 7_200_000, 'late'), 'later turn')])
    const candidates = await readOutboundCandidates(db, { syncFrom: uuidv7Floor(t0 + 3_600_000), limit: 1000 })
    expect(candidates.messages).toEqual([])
  })

  it('reads a page at a time and says when more is waiting', async () => {
    await startChat('one')
    await startChat('two')
    const page = await readOutboundCandidates(getDb(), { syncFrom, limit: 1 })
    expect(page.messages).toHaveLength(1)
    expect(page.hasMore).toBe(true)
  })

  it('says more is waiting when a page is full of deletes or renames, not only of new messages', async () => {
    const db = getDb()
    const chats = [await startChat('one'), await startChat('two')]
    await saveMapEntries(
      db,
      chats.flatMap((chat, i) => [
        {
          kind: 'thread' as const,
          localId: chat.threadId,
          remoteId: `conv-${i}`,
          source: 'local' as const,
          title: 'x',
        },
        {
          kind: 'message' as const,
          localId: chat.messageId,
          remoteId: `m-${i}`,
          source: 'local' as const,
          threadLocalId: chat.threadId,
        },
      ]),
    )
    await db.update(chatMessagesTable).set({ deletedAt: '2026-10-21T00:00:00.000Z' })
    const deletes = await readOutboundCandidates(db, { syncFrom, limit: 1 })
    expect(deletes.messages).toHaveLength(1)
    expect(deletes.hasMore).toBe(true)
    for (const chat of chats) {
      await updateChatThread(db, chat.threadId, { title: 'Renamed' })
    }
    await db.update(chatMessagesTable).set({ deletedAt: null })
    const renames = await readOutboundCandidates(db, { syncFrom, limit: 1 })
    expect(renames.threads).toHaveLength(1)
    expect(renames.hasMore).toBe(true)
  })
})

/** A provider whose stream yields `batches` once, then stays open until aborted. */
const fakeProvider = (
  batches: InboundBatch[],
  push: (batch: OutboundBatch) => Promise<PushAck>,
  { failPull }: { failPull?: () => unknown } = {},
): ExternalSyncProvider => {
  let opened = 0
  return {
    id: 'alpha',
    changes: async function* (_cursor, signal) {
      opened += 1
      if (failPull) {
        throw failPull()
      }
      if (opened === 1) {
        yield* batches
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
    push: (batch) => push(batch),
  }
}

/**
 * Polls `condition`, advancing the test's fake clock 10 ms per step so the engine's timers fire, and
 * yielding a real macrotask so database I/O can settle.
 */
const waitFor = async (condition: () => boolean | Promise<boolean>, steps = 300) => {
  for (let i = 0; !(await condition()); i++) {
    if (i >= steps) {
      throw new Error('timed out waiting')
    }
    await settle(10)
  }
}

/** Advances the fake clock by `ms` and lets pending I/O run. */
const settle = async (ms: number) => {
  await getClock().tickAsync(ms)
  await new Promise((resolve) => setImmediate(resolve))
}

type Run = {
  statuses: EngineStatus[]
  controls: () => EngineControls
  change: () => void
  stop: () => Promise<void>
  signedOut: () => boolean
  /** Settles when the engine stops on its own. */
  done: Promise<void>
}

type StartOptions = {
  syncFrom?: string | (() => Promise<string>)
  stalledMs?: number
  candidateLimit?: number
  waitForLocalData?: (signal: AbortSignal) => Promise<void>
  inboundBudget?: InboundBudget
}

const start = (
  provider: ExternalSyncProvider,
  { syncFrom: from = syncFrom, stalledMs = 500, candidateLimit, waitForLocalData, inboundBudget }: StartOptions = {},
): Run => {
  const statuses: EngineStatus[] = []
  const controller = new AbortController()
  let controls: EngineControls | null = null
  let onChange: () => void = () => {}
  let signedOut = false
  const done = runSyncEngine(
    {
      db: getDb(),
      provider,
      syncFrom: from,
      onStatus: (s) => statuses.push(s),
      onControls: (c) => {
        controls = c
      },
      onSignedOut: async () => {
        signedOut = true
      },
      settleMs: 20,
      stalledMs,
      candidateLimit,
      waitForLocalData,
      inboundBudget,
      firstPushDelayMs: 50,
      random: () => 0,
    },
    (fn) => {
      onChange = fn
      return () => {}
    },
    controller.signal,
  )
  return {
    statuses,
    controls: () => controls as unknown as EngineControls,
    change: () => onChange(),
    stop: async () => {
      controller.abort()
      await done
    },
    signedOut: () => signedOut,
    done,
  }
}

const last = (run: Run) => run.statuses.at(-1) as EngineStatus

/** A push that acknowledges every row and records each message's text by local id. */
const recordingPush =
  (sent: Map<string, string>) =>
  async (batch: OutboundBatch): Promise<PushAck> => {
    batch.messages.forEach((m) => sent.set(m.localId, m.text))
    return {
      threads: batch.threads.map((t) => ({ localId: t.localId, remoteId: `r-${t.localId}` })),
      messages: batch.messages.map((m) => ({ localId: m.localId, remoteId: `r-${m.localId}` })),
      rejected: [],
    }
  }

const assistantMessage = (id: string, parts: unknown[]): ThunderboltUIMessage =>
  ({ id, role: 'assistant', parts }) as ThunderboltUIMessage

describe('defaultChunkLimits', () => {
  it('cuts a large batch into pushes that each fit the server’s limits', () => {
    const message = (i: number) => ({
      localId: `m${i}`,
      remoteId: null,
      threadLocalId: `t${i % 300}`,
      threadRemoteId: null,
      role: 'user' as const,
      text: 'x'.repeat(5000),
      createdAt: 'x',
      deletedAt: null,
    })
    const threads = Array.from({ length: 300 }, (_, i) => ({
      localId: `t${i}`,
      remoteId: null,
      title: 'T',
      createdAt: 'x',
      deletedAt: null,
    }))
    const chunks = chunkBatch(
      { threads, messages: Array.from({ length: 2500 }, (_, i) => message(i)) },
      defaultChunkLimits,
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => fitsPushLimits(toPushBody(chunk)))).toBe(true)
  })
})

describe('choosing how to delete a synced chat', () => {
  const origin = 'https://alpha.example'
  const connect = () =>
    saveAlphaConnection(getDb(), {
      origin,
      credentials: { accessToken: 'a', refreshToken: 'r', expiresAt: null },
      metadata: {
        issuer: origin,
        authorization_endpoint: `${origin}/a`,
        token_endpoint: `${origin}/t`,
        response_types_supported: ['code'],
      },
    })

  it('offers the choice only for a chat this connected device syncs', async () => {
    const db = getDb()
    const { batch } = await pull(event([question]))
    const synced = batch.threads[0].localId
    const local = await startChat('never pushed')
    expect(await isChatSyncedToAlpha(db, synced, origin)).toBe(false)
    await connect()
    expect(await isChatSyncedToAlpha(db, synced, origin)).toBe(true)
    expect(await isChatSyncedToAlpha(db, local.threadId, origin)).toBe(false)
    expect(await isChatSyncedToAlpha(db, synced, 'https://other.example')).toBe(false)
  })

  it('sends nothing for a chat started here that the person removes from Thunderbolt only', async () => {
    const db = getDb()
    const chat = await startChat('mine')
    const out = await pendingPush()
    const ack = {
      threads: [{ localId: chat.threadId, remoteId: 'conv-mine' }],
      messages: [{ localId: chat.messageId, remoteId: 'r-mine' }],
      rejected: [],
    }
    await saveMapEntries(db, mapWritesForAck(out, ack, await loadIdMap(db)).mapWrites)
    await recordChatDeleteChoice(db, chat.threadId, 'here-only')
    await deleteChatThread(db, chat.threadId)
    expect(await pendingPush()).toMatchObject({ threads: [], messages: [] })
  })

  it('sends one conversation delete for a chat started here that the person deletes, never one per message', async () => {
    const db = getDb()
    const chat = await startChat('mine')
    const out = await pendingPush()
    const ack = {
      threads: [{ localId: chat.threadId, remoteId: 'conv-mine' }],
      messages: [{ localId: chat.messageId, remoteId: 'r-mine' }],
      rejected: [],
    }
    await saveMapEntries(db, mapWritesForAck(out, ack, await loadIdMap(db)).mapWrites)
    await recordChatDeleteChoice(db, chat.threadId, 'everywhere')
    await deleteChatThread(db, chat.threadId)
    expect(await pendingPush()).toMatchObject({
      threads: [expect.objectContaining({ localId: chat.threadId, remoteId: 'conv-mine' })],
      messages: [],
    })
  })
})

describe('inbound budget', () => {
  const budget: InboundBudget = { chats: 2, messages: 1000, chars: 1_000_000 }
  const conversation = (id: string, cursor: string) =>
    toInbound(
      event([], {
        cursor,
        conversations: [{ ...event([]).conversations[0], id, messages: [{ ...question, id: `${id}-m1` }] }],
      }),
      ctx,
    )
  const chatCount = async () => (await getDb().select().from(chatThreadsTable)).length
  const day = 86_400_000

  it('pauses a batch that adds chats once the day’s budget is spent, writing nothing, and takes it the next day', async () => {
    const db = getDb()
    const at = Date.parse('2026-10-21T08:00:00.000Z')
    for (const [i, id] of ['conv-1', 'conv-2'].entries()) {
      await applyInboundWithinBudget(
        db,
        await loadIdMap(db),
        await conversation(id, `c${i}`),
        { syncFrom },
        { budget, at },
      )
    }
    const third = await conversation('conv-3', 'c2')
    const error = await applyInboundWithinBudget(
      db,
      await loadIdMap(db),
      third,
      { syncFrom },
      { budget, at: at + 1000 },
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'paused', code: 'inbound-limit' })
    expect(await chatCount()).toBe(2)
    await applyInboundWithinBudget(db, await loadIdMap(db), third, { syncFrom }, { budget, at: at + day })
    expect(await chatCount()).toBe(3)
  })

  it('still applies a batch that only deletes once the budget is spent', async () => {
    const db = getDb()
    const at = Date.parse('2026-10-21T08:00:00.000Z')
    for (const [i, id] of ['conv-1', 'conv-2'].entries()) {
      await applyInboundWithinBudget(
        db,
        await loadIdMap(db),
        await conversation(id, `c${i}`),
        { syncFrom },
        { budget, at },
      )
    }
    const tombstone = await toInbound(
      event([], {
        cursor: 'c3',
        conversations: [],
        tombstones: [{ kind: 'conversation', id: 'conv-1', clientId: null, deletedAt: 'x' }],
      }),
      ctx,
    )
    await applyInboundWithinBudget(db, await loadIdMap(db), tombstone, { syncFrom }, { budget, at })
    const live = await getDb().select().from(chatThreadsTable).where(isNull(chatThreadsTable.deletedAt))
    expect(live).toHaveLength(1)
  })

  it('counts records of skipped conversations against the budget, so a spent budget pauses them too', async () => {
    const db = getDb()
    const at = Date.parse('2026-10-21T08:00:00.000Z')
    const bogus = (cursor: string, ids: string[]) =>
      toInbound(event([], { cursor, conversations: ids.map((id) => ({ id }) as never) }), ctx)
    await applyInboundWithinBudget(
      db,
      await loadIdMap(db),
      await bogus('c1', ['x1', 'x2']),
      { syncFrom },
      { budget, at },
    )
    expect([...(await loadIdMap(db)).threads.keys()].sort()).toEqual(['skipped:x1', 'skipped:x2'])
    const error = await applyInboundWithinBudget(
      db,
      await loadIdMap(db),
      await bogus('c2', ['x3']),
      { syncFrom },
      { budget, at: at + 1000 },
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'paused', code: 'inbound-limit' })
    expect((await loadIdMap(db)).threads.size).toBe(2)
  })

  it('writes one record for an event of 20,000 bogus conversations, and none once the day’s budget is spent', async () => {
    const db = getDb()
    const raw = {
      v: 1,
      cursor: 'c1',
      conversations: Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}` })),
      tombstones: [],
    }
    const batch = await toInbound(raw, ctx)
    const spent = { chats: 0, messages: 0, chars: 0 }
    const error = await applyInboundWithinBudget(
      db,
      await loadIdMap(db),
      batch,
      { syncFrom },
      { budget: spent, at: 0 },
    ).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'paused', code: 'inbound-limit' })
    expect((await loadIdMap(db)).threads.size).toBe(0)
    const plan = await applyInboundWithinBudget(db, await loadIdMap(db), batch, { syncFrom }, { budget, at: 0 })
    expect(plan.skippedEvent).toBe(true)
    expect([...(await loadIdMap(db)).threads.keys()]).toEqual(['skipped-event:c1'])
  })

  it('pauses the pull with a reason on the card once AI Potluck sends more new chats than a day’s budget', async () => {
    const batches = [
      await conversation('conv-1', 'c1'),
      await conversation('conv-2', 'c2'),
      await conversation('conv-3', 'c3'),
    ]
    const run = start(fakeProvider(batches, recordingPush(new Map())), { inboundBudget: budget })
    await waitFor(() => last(run)?.pull.state === 'paused')
    await run.stop()
    expect(last(run).pull.error).toBe('inbound-limit')
    expect(await chatCount()).toBe(2)
    expect(await getMeta(getDb(), metaKeys.cursor)).toBe('c2')
  })
})

describe('reconnecting', () => {
  it('applies AI Potluck turns to a chat started here and synced, after Disconnect and a sign-out wiped this device’s bridge state', async () => {
    const db = getDb()
    const origin = 'https://alpha.example'
    const t0 = Date.parse('2026-10-20T10:00:00.000Z')
    const hour = 3_600_000
    await beginSyncState(db, origin, t0 - 60_000)
    await saveAlphaConnection(db, {
      origin,
      credentials: { accessToken: 'a', refreshToken: 'r', expiresAt: null },
      metadata: {
        issuer: origin,
        authorization_endpoint: `${origin}/a`,
        token_endpoint: `${origin}/t`,
        response_types_supported: ['code'],
      },
    })
    const threadId = uuidv7At(t0, 'tb-thread')
    const messageId = uuidv7At(t0 + 1000, 'tb-message')
    await getOrCreateChatThread(db, threadId, modelId, { isEncrypted: 0 })
    await saveMessagesWithContextUpdate(db, threadId, [userMessage(messageId, 'question from Thunderbolt')])
    await disconnectAlpha(db, null)
    // Signing out wipes this device's local-only bridge state; the chat and settings sync back.
    await clearIdMap(db)
    await deleteMeta(db, [metaKeys.syncFrom, metaKeys.origin])
    await beginSyncState(db, origin, t0 + 3 * hour)
    const syncFromAfter = uuidv7Floor(Number(await getMeta(db, metaKeys.syncFrom)))
    const raw: ChangesEventV1 = {
      v: 1,
      cursor: 'c1',
      conversations: [
        {
          id: 'conv-tb',
          clientId: threadId,
          origin: ctx.clientId,
          title: 'From Thunderbolt',
          createdAt: new Date(t0).toISOString(),
          updatedAt: new Date(t0 + 2 * hour).toISOString(),
          messages: [
            {
              id: 'r1',
              clientId: messageId,
              origin: ctx.clientId,
              role: 'user',
              content: 'question from Thunderbolt',
              createdAt: new Date(t0 + 1000).toISOString(),
            },
            {
              id: 'r2',
              clientId: null,
              origin: 'alpha',
              role: 'assistant',
              content: 'reply written on AI Potluck',
              createdAt: new Date(t0 + 2 * hour).toISOString(),
            },
          ],
        },
      ],
      tombstones: [],
    }
    const batch = await toInbound(raw, { ...ctx, now: t0 + 4 * hour })
    await applyInbound(db, await loadIdMap(db), batch, { syncFrom: syncFromAfter })
    expect((await liveMessages(threadId)).map((m) => m.content)).toEqual([
      'question from Thunderbolt',
      'reply written on AI Potluck',
    ])
  })
})

describe('runSyncEngine', () => {
  it('pushes a chat started here once, and never pushes back what it pulled', async () => {
    const pushes: OutboundBatch[] = []
    const inbound = await toInbound(event([question, answer]), ctx)
    const run = start(
      fakeProvider([inbound], async (batch) => {
        pushes.push(batch)
        return {
          threads: batch.threads.map((t) => ({ localId: t.localId, remoteId: `r-${t.localId}` })),
          messages: batch.messages.map((m) => ({ localId: m.localId, remoteId: `r-${m.localId}` })),
          rejected: [],
        }
      }),
    )
    await waitFor(() => last(run)?.pull.state === 'ok' && last(run)?.push.state === 'ok')
    const chat = await startChat('hello from Thunderbolt')
    run.change()
    await waitFor(() => pushes.length === 1)
    run.change()
    for (let i = 0; i < 10; i++) {
      await settle(10)
    }
    await run.stop()
    expect(pushes).toHaveLength(1)
    expect(pushes[0].threads.map((t) => t.localId)).toEqual([chat.threadId])
    expect(pushes[0].messages.map((m) => m.localId)).toEqual([chat.messageId])
  })

  it('pushes a reply stopped mid-stream once it stays unchanged for stalledMs, and the chat’s later messages after it', async () => {
    const sent = new Map<string, string>()
    const chat = await startChat('question')
    await getClock().tickAsync(5)
    const reply = uuidv7()
    // A reply the person stopped: its text part never leaves the streaming state.
    await saveMessagesWithContextUpdate(getDb(), chat.threadId, [
      assistantMessage(reply, [{ type: 'text', text: 'Half an ans', state: 'streaming' }]),
    ])
    await getClock().tickAsync(5)
    const next = uuidv7()
    await saveMessagesWithContextUpdate(getDb(), chat.threadId, [userMessage(next, 'next question')])
    const run = start(fakeProvider([], recordingPush(sent)))
    await waitFor(() => sent.has(chat.messageId))
    await settle(100)
    expect(sent.has(reply)).toBe(false)
    expect(sent.has(next)).toBe(false)
    await waitFor(() => sent.has(next))
    await run.stop()
    expect(sent.get(reply)).toBe('Half an ans')
  })

  it('holds a reply while its tool call runs past settleMs, then pushes the finished text', async () => {
    const sent = new Map<string, string>()
    const chat = await startChat('find the recipe')
    await getClock().tickAsync(5)
    const reply = uuidv7()
    const intro = { type: 'text', text: 'Let me search.', state: 'done' }
    await saveMessagesWithContextUpdate(getDb(), chat.threadId, [
      assistantMessage(reply, [intro, { type: 'tool-search', toolCallId: 'c1', state: 'input-available', input: {} }]),
    ])
    const run = start(fakeProvider([], recordingPush(sent)), { stalledMs: 60_000 })
    await waitFor(() => sent.has(chat.messageId))
    await settle(200)
    expect(sent.has(reply)).toBe(false)
    await saveMessagesWithContextUpdate(getDb(), chat.threadId, [
      assistantMessage(reply, [
        intro,
        { type: 'tool-search', toolCallId: 'c1', state: 'output-available', input: {}, output: 'found' },
        { type: 'step-start' },
        { type: 'text', text: ' Found it.', state: 'done' },
      ]),
    ])
    run.change()
    await waitFor(() => sent.has(reply))
    await run.stop()
    expect(sent.get(reply)).toBe('Let me search. Found it.')
  })

  it('records empty replies once they stall, so a page full of them never keeps later messages from being pushed', async () => {
    const sent = new Map<string, string>()
    const chat = await startChat('question')
    for (let i = 0; i < 3; i++) {
      await getClock().tickAsync(5)
      await saveMessagesWithContextUpdate(getDb(), chat.threadId, [
        assistantMessage(uuidv7(), [{ type: 'text', text: '', state: 'done' }]),
      ])
    }
    await getClock().tickAsync(5)
    const next = uuidv7()
    await saveMessagesWithContextUpdate(getDb(), chat.threadId, [userMessage(next, 'still there?')])
    const run = start(fakeProvider([], recordingPush(sent)), { candidateLimit: 2 })
    await waitFor(() => sent.has(next))
    await run.stop()
    expect([...sent.keys()]).toEqual([chat.messageId, next])
    expect(last(run).notSynced).toBeGreaterThan(0)
  })

  it('waits for this device’s own chat rows before it settles its sync window, pulls or pushes anything', async () => {
    const sent = new Map<string, string>()
    let opened = 0
    let windows = 0
    let release: () => void = () => {}
    const localData = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = fakeProvider([], recordingPush(sent))
    const counting: ExternalSyncProvider = {
      ...provider,
      changes: (cursor, signal) => {
        opened += 1
        return provider.changes(cursor, signal)
      },
    }
    const chat = await startChat('hello')
    const settleWindow = async () => {
      windows += 1
      return syncFrom
    }
    const run = start(counting, { syncFrom: settleWindow, waitForLocalData: () => localData })
    await settle(300)
    expect(opened).toBe(0)
    expect(sent.size).toBe(0)
    expect(windows).toBe(0)
    release()
    await waitFor(() => sent.has(chat.messageId) && opened === 1)
    await run.stop()
    expect(windows).toBe(1)
  })

  it('stops with a local-data error, and neither pulls nor pushes, when this device’s chat rows cannot be loaded', async () => {
    const sent = new Map<string, string>()
    let opened = 0
    const provider = fakeProvider([], recordingPush(sent))
    const counting: ExternalSyncProvider = {
      ...provider,
      changes: (cursor, signal) => {
        opened += 1
        return provider.changes(cursor, signal)
      },
    }
    await startChat('hello')
    const run = start(counting, {
      waitForLocalData: async () => {
        throw new Error('database closed')
      },
    })
    let outcome: unknown = 'running'
    run.done.then(
      () => {
        outcome = 'finished'
      },
      (error: unknown) => {
        outcome = error
      },
    )
    await waitFor(() => outcome !== 'running')
    expect(outcome).toMatchObject({ kind: 'paused', code: 'local-data' })
    expect(opened).toBe(0)
    expect(sent.size).toBe(0)
  })

  it('finds and records the one row AI Potluck refuses outright, and still sends the rest', async () => {
    const pushed: string[] = []
    await startChat('fine')
    const bad = await startChat('the server refuses this one')
    const run = start(
      fakeProvider([], async (batch) => {
        if (batch.messages.some((m) => m.localId === bad.messageId)) {
          throw new HttpError(new Response(null, { status: 400 }))
        }
        pushed.push(...batch.messages.map((m) => m.localId))
        return {
          threads: batch.threads.map((t) => ({ localId: t.localId, remoteId: `r-${t.localId}` })),
          messages: batch.messages.map((m) => ({ localId: m.localId, remoteId: `r-${m.localId}` })),
          rejected: [],
        }
      }),
    )
    await waitFor(() => last(run)?.notSynced === 1)
    await run.stop()
    expect(pushed).toHaveLength(1)
    expect(pushed).not.toContain(bad.messageId)
    expect((await loadIdMap(getDb())).messages.get(bad.messageId)?.rejected).toBe('invalid')
  })

  it('stops a pass after a bounded number of refused pushes when AI Potluck refuses every push, and backs off', async () => {
    for (let i = 0; i < 40; i++) {
      await startChat(`chat ${i}`)
    }
    let pushes = 0
    const run = start(
      fakeProvider([], async () => {
        pushes += 1
        throw new HttpError(new Response(null, { status: 400 }))
      }),
    )
    await waitFor(() => last(run)?.push.state === 'paused')
    await run.stop()
    expect(last(run).push.error).toBe('rejected')
    // 80 rows: splitting down to every single one would take 159 pushes.
    expect(pushes).toBe(25)
  })

  /** A chat from AI Potluck with the person's acked turn, deleted here with "delete everywhere". */
  const chatDeletedEverywhere = async () => {
    const db = getDb()
    const chat = await startChat('hello')
    const [thread] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, chat.threadId))
    await saveMapEntries(db, [
      { kind: 'thread', localId: chat.threadId, remoteId: 'conv-r', source: 'remote', title: thread.title },
      { kind: 'message', localId: chat.messageId, remoteId: 'msg-r', source: 'local', threadLocalId: chat.threadId },
    ])
    await recordChatDeleteChoice(db, chat.threadId, 'everywhere')
    await deleteChatThread(db, chat.threadId)
    return chat
  }

  it('keeps a delete-everywhere unsent while AI Potluck refuses whole bodies, and sends it on Retry', async () => {
    const chat = await chatDeletedEverywhere()
    let refuse = true
    let pushes = 0
    const deletesSent: string[] = []
    const run = start(
      fakeProvider([], async (batch) => {
        pushes += 1
        if (refuse) {
          throw new HttpError(new Response(null, { status: 400 }))
        }
        deletesSent.push(...batch.threads.filter((t) => t.deletedAt).map((t) => t.remoteId ?? ''))
        return { threads: [], messages: [], rejected: [] }
      }),
    )
    await waitFor(() => last(run)?.push.state === 'paused')
    const held = (await loadIdMap(getDb())).threads.get(chat.threadId)
    expect(pushes).toBeGreaterThanOrEqual(1)
    expect(held).toMatchObject({ remoteId: 'conv-r' })
    expect(held?.deleted).toBeUndefined()
    expect(held?.rejected).toBeUndefined()
    expect(last(run).push.error).toBe('rejected')
    refuse = false
    await run.controls().retryRejected()
    await waitFor(() => deletesSent.length > 0)
    await run.stop()
    expect(deletesSent).toEqual(['conv-r'])
    expect((await loadIdMap(getDb())).threads.get(chat.threadId)?.deleted).toBe(true)
  })

  it('sends a delete and a rename refused with the whole body again after the backoff, without Retry', async () => {
    await chatDeletedEverywhere()
    const db = getDb()
    const renamed = await startChat('keep me')
    const [thread] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, renamed.threadId))
    await saveMapEntries(db, [
      { kind: 'thread', localId: renamed.threadId, remoteId: 'conv-k', source: 'local', title: thread.title },
      {
        kind: 'message',
        localId: renamed.messageId,
        remoteId: 'msg-k',
        source: 'local',
        threadLocalId: renamed.threadId,
      },
    ])
    await updateChatThread(db, renamed.threadId, { title: 'Renamed here' })
    let refusals = 2
    const sent: { remoteId: string | null; title: string | null; deleted: boolean }[] = []
    const run = start(
      fakeProvider([], async (batch) => {
        if (refusals > 0) {
          refusals -= 1
          throw new HttpError(new Response(null, { status: 400 }))
        }
        sent.push(
          ...batch.threads.map((t) => ({ remoteId: t.remoteId, title: t.title, deleted: t.deletedAt !== null })),
        )
        return { threads: [], messages: [], rejected: [] }
      }),
    )
    await waitFor(() => sent.length === 2, 1000)
    await run.stop()
    expect(sent).toEqual(
      expect.arrayContaining([
        { remoteId: 'conv-r', title: null, deleted: true },
        { remoteId: 'conv-k', title: 'Renamed here', deleted: false },
      ]),
    )
    expect((await loadIdMap(db)).threads.get(renamed.threadId)?.title).toBe('Renamed here')
  })

  it('sends a refused row again when the person presses Retry', async () => {
    let refuse = true
    const chat = await startChat('try me again')
    const run = start(
      fakeProvider([], async (batch) => ({
        threads: batch.threads.map((t) => ({ localId: t.localId, remoteId: `r-${t.localId}` })),
        messages: refuse ? [] : batch.messages.map((m) => ({ localId: m.localId, remoteId: `r-${m.localId}` })),
        rejected: refuse
          ? batch.messages.map((m) => ({ kind: 'message' as const, localId: m.localId, reason: 'busy' }))
          : [],
      })),
    )
    await waitFor(() => last(run)?.notSynced === 1)
    refuse = false
    await run.controls().retryRejected()
    await waitFor(
      async () => (await loadIdMap(getDb())).messages.get(chat.messageId)?.remoteId === `r-${chat.messageId}`,
    )
    await run.stop()
    expect(last(run).notSynced).toBe(0)
  })

  it('reads a skipped event again from just before it when the person presses Retry, and stops counting it', async () => {
    const opened: (string | null)[] = []
    const provider: ExternalSyncProvider = {
      id: 'alpha',
      changes: async function* (cursor, signal) {
        opened.push(cursor)
        if (opened.length === 1) {
          yield { cursor: 'c1', threads: [], tombstones: [] }
          yield { cursor: 'c2', threads: [], tombstones: [], skipped: [{ remoteId: null, reason: 'unreadable' }] }
          yield { cursor: 'c3', threads: [], tombstones: [] }
        }
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      push: async () => ({ threads: [], messages: [], rejected: [] }),
    }
    const run = start(provider)
    await waitFor(async () => last(run)?.notSynced === 1 && (await getMeta(getDb(), metaKeys.cursor)) === 'c3')
    await run.controls().retryRejected()
    await waitFor(() => opened.length === 2)
    await run.stop()
    expect(opened).toEqual([null, 'c1'])
    expect(last(run).notSynced).toBe(0)
  })

  it('reports pull and push separately: a failing stream does not hide that pushing works', async () => {
    const run = start(
      fakeProvider([], async () => ({ threads: [], messages: [], rejected: [] }), {
        failPull: () => new TypeError('Failed to fetch'),
      }),
    )
    await waitFor(() => last(run)?.pull.state === 'retrying' && last(run)?.push.state === 'ok')
    await run.stop()
    expect(last(run).pull).toMatchObject({ state: 'retrying', error: 'offline', nextRetryAt: expect.any(Number) })
  })

  it('stops and reports signed-out only when AI Potluck refuses the refresh token', async () => {
    const run = start(
      fakeProvider([], async () => ({ threads: [], messages: [], rejected: [] }), {
        failPull: () => new SyncError('reauth', 'signed-out'),
      }),
    )
    await waitFor(() => last(run)?.pull.state === 'signed-out')
    await run.stop()
    expect(run.signedOut()).toBe(true)
    expect(last(run).push.state).toBe('signed-out')
  })
})
