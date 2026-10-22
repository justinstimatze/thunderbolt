/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Chat } from '@ai-sdk/react'
import { v7 as uuidv7 } from 'uuid'
import type { ChatSession } from '@/chats/chat-store'
import { getChatMessages } from '@/dal/chat-messages'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { modelsTable } from '@/db/tables'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import { applyInbound, inboundTouched } from './engine'
import { uuidv7Floor } from './ids'
import { toInbound, type ChangesEventV1 } from './map'
import { createOpenChatRefresher, refreshOpenChats } from './refresh-open-chats'
import { loadIdMap } from './storage'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  await resetTestDatabase()
  await getDb().insert(modelsTable).values({
    id: uuidv7(),
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

const syncFrom = uuidv7Floor(Date.parse('2026-01-01T00:00:00.000Z'))
const question = {
  id: 'm1',
  clientId: null,
  role: 'user' as const,
  content: 'How long to proof?',
  createdAt: '2026-10-20T12:00:01.000Z',
  origin: 'alpha',
}
const reply = (content: string) => ({ ...question, id: 'm2', role: 'assistant' as const, content })

const event = (messages: ChangesEventV1['conversations'][number]['messages']): ChangesEventV1 => ({
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
})

const pull = async (raw: ChangesEventV1) => {
  const db = getDb()
  const batch = await toInbound(raw, { clientId: 'thunderbolt-test' })
  const plan = await applyInbound(db, await loadIdMap(db), batch, { syncFrom })
  return { threadId: batch.threads[0].localId, touched: inboundTouched(plan) }
}

/** A chat store holding one open chat, loaded from the database the way hydration loads it. */
const openChat = async (
  threadId: string,
  { status, retryCount = 0 }: { status?: 'streaming' | 'error'; retryCount?: number } = {},
) => {
  const rows = await getChatMessages(getDb(), threadId)
  const chat = new Chat<ThunderboltUIMessage>({
    id: threadId,
    messages: rows.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
  })
  if (status) {
    Object.defineProperty(chat, 'status', { get: () => status })
  }
  const sessions = new Map([
    [threadId, { chatInstance: chat, retriesExhausted: true, retryCount } as unknown as ChatSession],
  ])
  const updates: Partial<ChatSession>[] = []
  const store = {
    getState: () =>
      ({
        sessions,
        updateSession: (_id: string, patch: Partial<ChatSession>) => updates.push(patch),
      }) as never,
  }
  return { chat, store, updates }
}

const texts = (messages: ThunderboltUIMessage[]) =>
  messages.map((m) => m.parts.map((p) => ('text' in p ? p.text : '')).join(''))

describe('refreshOpenChats', () => {
  it('shows a reply AI Potluck filled in after the question synced, in a chat already open', async () => {
    const first = await pull(event([question, reply('')]))
    const { chat, store, updates } = await openChat(first.threadId)
    const second = await pull(event([question, reply('About an hour.')]))
    expect(second.touched).toEqual([first.threadId])

    await refreshOpenChats(getDb(), second.touched!, { store })

    expect(texts(chat.messages).at(-1)).toBe('About an hour.')
    expect(updates).toEqual([{ retriesExhausted: false }])
  })

  it('leaves a chat alone while a reply is being written in it here', async () => {
    const first = await pull(event([question, reply('')]))
    const { chat, store, updates } = await openChat(first.threadId, { status: 'streaming' })
    const before = texts(chat.messages)
    await pull(event([question, reply('About an hour.')]))

    await refreshOpenChats(getDb(), [first.threadId], { store })

    expect(texts(chat.messages)).toEqual(before)
    expect(updates).toEqual([])
  })

  it('reads nothing for chats that are not open', async () => {
    const first = await pull(event([question, reply('About an hour.')]))
    const { store } = await openChat(first.threadId)
    const reads: string[] = []
    await refreshOpenChats(getDb(), ['some-other-chat'], {
      store,
      read: async (db, id) => (reads.push(id), getChatMessages(db, id)),
    })
    expect(reads).toEqual([])
  })

  it('touches nothing when the batch changed no message', async () => {
    await pull(event([question, reply('About an hour.')]))
    const again = await pull(event([question, reply('About an hour.')]))
    expect(again.touched).toBeNull()
  })
  it('leaves a chat alone while it fails or waits to retry a reply of its own', async () => {
    const first = await pull(event([question, reply('')]))
    const failed = await openChat(first.threadId, { status: 'error' })
    const retrying = await openChat(first.threadId, { retryCount: 1 })
    await pull(event([question, reply('About an hour.')]))

    await refreshOpenChats(getDb(), [first.threadId], { store: failed.store })
    await refreshOpenChats(getDb(), [first.threadId], { store: retrying.store })

    expect(texts(failed.chat.messages)).toEqual(['How long to proof?'])
    expect(texts(retrying.chat.messages)).toEqual(['How long to proof?'])
  })

  it('keeps a reply this device just finished, before its save reaches the database', async () => {
    const first = await pull(event([question, reply('About an hour.')]))
    const { chat, store } = await openChat(first.threadId)
    const ownReply = { id: uuidv7(), role: 'assistant', parts: [{ type: 'text', text: 'Mine, not saved yet.' }] }
    chat.messages = [...chat.messages, ownReply as ThunderboltUIMessage]
    await pull(event([question, reply('About an hour, maybe less.')]))

    await refreshOpenChats(getDb(), [first.threadId], { store })

    expect(texts(chat.messages).at(-1)).toBe('Mine, not saved yet.')
  })
})

describe('createOpenChatRefresher', () => {
  it('runs one pass at a time and folds chats named meanwhile into the next pass', async () => {
    const first = await pull(event([question, reply('About an hour.')]))
    const { store } = await openChat(first.threadId)
    const passes: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const refresh = createOpenChatRefresher(getDb(), {
      store,
      read: async (db, id) => {
        passes.push(id)
        await gate
        return getChatMessages(db, id)
      },
    })
    const done = refresh([first.threadId])
    void refresh([first.threadId])
    void refresh('all')
    release()
    await done
    await refresh([])
    expect(passes).toEqual([first.threadId, first.threadId])
  })
})
