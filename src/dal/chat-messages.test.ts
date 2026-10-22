/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, modelsTable } from '@/db/tables'
import type { ThunderboltUIMessage } from '@/types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, isNotNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  deleteChatMessageAndDescendants,
  getChatMessages,
  getLastMessage,
  saveMessagesWithContextUpdate,
  saveChatMessagesWithParents,
  saveStreamingAssistantMessage,
  restoreChatMessages,
  softDeleteChatMessages,
} from './chat-messages'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Chat Messages DAL', () => {
  beforeEach(async () => {
    // Reset database before each test to prevent pollution from randomized test order
    await resetTestDatabase()
  })

  describe('getChatMessages', () => {
    it('should return empty array when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages = await getChatMessages(getDb(), threadId)
      expect(messages).toEqual([])
    })

    it('should return messages for a thread', async () => {
      const threadId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'Hello',
        },
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Hi there!',
        },
      ])

      const messages = await getChatMessages(getDb(), threadId)
      expect(messages).toHaveLength(2)
      expect(messages.map((m) => m.id)).toContain(messageId1)
      expect(messages.map((m) => m.id)).toContain(messageId2)
    })

    it('should return messages ordered by id', async () => {
      const threadId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()

      // Insert messages in reverse order
      await db.insert(chatMessagesTable).values([
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Second message',
        },
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'First message',
        },
      ])

      const messages = await getChatMessages(getDb(), threadId)
      expect(messages).toHaveLength(2)
      expect(messages[0]?.id).toBe(messageId1)
      expect(messages[1]?.id).toBe(messageId2)
    })
  })

  describe('getLastMessage', () => {
    it('should return null when thread has no messages', async () => {
      const threadId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const lastMessage = await getLastMessage(getDb(), threadId)
      expect(lastMessage).toBeNull()
    })

    it('should return the last message for a thread', async () => {
      const threadId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const modelId = uuidv7()

      // Create model first
      await db.insert(modelsTable).values({
        id: modelId,
        provider: 'openai',
        name: 'Test Model',
        model: 'gpt-4',
        isSystem: 0,
        enabled: 1,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: messageId1,
          chatThreadId: threadId,
          role: 'user',
          content: 'First message',
        },
        {
          id: messageId2,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Last message',
          modelId: modelId,
        },
      ])

      const lastMessage = await getLastMessage(getDb(), threadId)
      expect(lastMessage).not.toBeUndefined()
      expect(lastMessage?.id).toBe(messageId2)
      expect(lastMessage?.modelId).toBe(modelId)
    })
  })

  describe('saveMessagesWithContextUpdate with parent_id', () => {
    it('should set parent_id to null for first message in empty thread', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'user',
          parts: [{ type: 'text', text: 'First message' }],
        },
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const savedMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0]?.parentId).toBe(null)
    })

    it('should set parent_id to last message when adding new message', async () => {
      const threadId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values({
        id: messageId1,
        chatThreadId: threadId,
        role: 'user',
        content: 'First message',
        parentId: null,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId2,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Second message' }],
        },
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const savedMessages = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId2))
      expect(savedMessages).toHaveLength(1)
      expect(savedMessages[0]?.parentId).toBe(messageId1)
    })

    it('should chain multiple messages in batch correctly', async () => {
      const threadId = uuidv7()
      const existingMessageId = uuidv7()
      const messageId1 = uuidv7()
      const messageId2 = uuidv7()
      const messageId3 = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Insert existing message
      await db.insert(chatMessagesTable).values({
        id: existingMessageId,
        chatThreadId: threadId,
        role: 'user',
        content: 'Existing message',
        parentId: null,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId1,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Message 1' }],
        },
        {
          id: messageId2,
          role: 'user',
          parts: [{ type: 'text', text: 'Message 2' }],
        },
        {
          id: messageId3,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Message 3' }],
        },
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const allMessages = await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatThreadId, threadId))
        .orderBy(chatMessagesTable.id)

      expect(allMessages).toHaveLength(4)

      // First new message should point to existing message
      const msg1 = allMessages.find((m) => m.id === messageId1)
      expect(msg1?.parentId).toBe(existingMessageId)

      // Second new message should point to first new message
      const msg2 = allMessages.find((m) => m.id === messageId2)
      expect(msg2?.parentId).toBe(messageId1)

      // Third new message should point to second new message
      const msg3 = allMessages.find((m) => m.id === messageId3)
      expect(msg3?.parentId).toBe(messageId2)
    })

    it('should fall back to update when message id already exists (insert-first pattern for PowerSync)', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Insert message directly to simulate race: another caller already saved it
      await db.insert(chatMessagesTable).values({
        id: messageId,
        chatThreadId: threadId,
        role: 'user',
        content: 'Original content',
        parentId: null,
      })

      // saveMessagesWithContextUpdate tries insert first, gets PRIMARY KEY constraint, falls back to update
      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Updated content' }],
        },
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const saved = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId)).get()
      expect(saved?.content).toBe('Updated content')
      expect(saved?.role).toBe('assistant')
    })

    it('should not overwrite parent_id when re-saving an existing message (self-parent guard)', async () => {
      // Reproduces the streaming re-save: the assistant row already exists and is
      // now the newest message in the thread, so `getLastMessage` would return
      // the row itself. The conflict-update must NOT re-point parent_id to that
      // (making the message its own parent).
      const threadId = uuidv7()
      const userMessageId = uuidv7()
      const assistantMessageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      await db.insert(chatMessagesTable).values([
        { id: userMessageId, chatThreadId: threadId, role: 'user', content: 'Question', parentId: null },
        {
          id: assistantMessageId,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Partial',
          parentId: userMessageId,
        },
      ])

      const messages: ThunderboltUIMessage[] = [
        {
          id: assistantMessageId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Complete answer' }],
        },
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const saved = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, assistantMessageId)).get()
      expect(saved?.content).toBe('Complete answer')
      // parent_id stays pointed at the user message, never at itself.
      expect(saved?.parentId).toBe(userMessageId)
    })

    it('should update context size from message metadata', async () => {
      const threadId = uuidv7()
      const messageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      const messages: ThunderboltUIMessage[] = [
        {
          id: messageId,
          role: 'assistant',
          parts: [{ type: 'text', text: 'Response' }],
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 200,
              totalTokens: 300,
            },
          },
        },
      ]

      await saveMessagesWithContextUpdate(getDb(), threadId, messages)

      const thread = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId)).get()
      expect(thread?.contextSize).toBe(300)
    })
  })

  describe('saveStreamingAssistantMessage', () => {
    it('should insert a new assistant message with the supplied parent_id', async () => {
      const threadId = uuidv7()
      const userMessageId = uuidv7()
      const assistantMessageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      await db.insert(chatMessagesTable).values({
        id: userMessageId,
        chatThreadId: threadId,
        role: 'user',
        content: 'Question',
        parentId: null,
      })

      await saveStreamingAssistantMessage(
        getDb(),
        threadId,
        { id: assistantMessageId, role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] },
        userMessageId,
      )

      const saved = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, assistantMessageId)).get()
      expect(saved?.role).toBe('assistant')
      expect(saved?.content).toBe('Partial')
      expect(saved?.parentId).toBe(userMessageId)
    })

    it('should update content/parts on repeat saves without changing parent_id', async () => {
      const threadId = uuidv7()
      const userMessageId = uuidv7()
      const assistantMessageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      await db.insert(chatMessagesTable).values({
        id: userMessageId,
        chatThreadId: threadId,
        role: 'user',
        content: 'Question',
        parentId: null,
      })

      // First partial → insert with the correct parent.
      await saveStreamingAssistantMessage(
        getDb(),
        threadId,
        { id: assistantMessageId, role: 'assistant', parts: [{ type: 'text', text: 'Hel' }] },
        userMessageId,
      )

      // Subsequent partials pass parentId=null (caller only recomputes the parent
      // once); the upsert must keep the original parent, never null it out.
      await saveStreamingAssistantMessage(
        getDb(),
        threadId,
        { id: assistantMessageId, role: 'assistant', parts: [{ type: 'text', text: 'Hello world' }] },
        null,
      )

      const saved = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, assistantMessageId)).get()
      expect(saved?.content).toBe('Hello world')
      expect(saved?.parentId).toBe(userMessageId)

      // Exactly one row for the message id (no duplicate inserted).
      const all = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, assistantMessageId))
      expect(all).toHaveLength(1)
    })

    it('should not require a thread row to exist (skips the existence check)', async () => {
      // The generic path throws "Thread not found"; the fast path trusts the
      // streaming invariant and goes straight to the upsert.
      const threadId = uuidv7()
      const assistantMessageId = uuidv7()
      const db = getDb()

      await saveStreamingAssistantMessage(
        getDb(),
        threadId,
        { id: assistantMessageId, role: 'assistant', parts: [{ type: 'text', text: 'Orphan-safe' }] },
        null,
      )

      const saved = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, assistantMessageId)).get()
      expect(saved?.content).toBe('Orphan-safe')
    })
  })

  describe('cascade delete with parent_id', () => {
    it('should delete child messages when parent is deleted', async () => {
      const threadId = uuidv7()
      const parentMessageId = uuidv7()
      const childMessageId = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      await db.insert(chatMessagesTable).values([
        {
          id: parentMessageId,
          chatThreadId: threadId,
          role: 'user',
          content: 'Parent message',
          parentId: null,
        },
        {
          id: childMessageId,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Child message',
          parentId: parentMessageId,
        },
      ])

      // Soft delete parent message and descendants (DAL cascade)
      await deleteChatMessageAndDescendants(getDb(), parentMessageId)

      // No messages visible (soft-deleted)
      const messages = await getChatMessages(getDb(), threadId)
      expect(messages).toHaveLength(0)
    })

    it('should delete entire chain when root message is deleted', async () => {
      const threadId = uuidv7()
      const msg1Id = uuidv7()
      const msg2Id = uuidv7()
      const msg3Id = uuidv7()
      const msg4Id = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create a chain: msg1 -> msg2 -> msg3 -> msg4
      await db.insert(chatMessagesTable).values([
        {
          id: msg1Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 1',
          parentId: null,
        },
        {
          id: msg2Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 2',
          parentId: msg1Id,
        },
        {
          id: msg3Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 3',
          parentId: msg2Id,
        },
        {
          id: msg4Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 4',
          parentId: msg3Id,
        },
      ])

      // Soft delete root message and descendants (DAL cascade)
      await deleteChatMessageAndDescendants(getDb(), msg1Id)

      // No messages visible (soft-deleted)
      const messages = await getChatMessages(getDb(), threadId)
      expect(messages).toHaveLength(0)
    })

    it('should delete only descendant branch when deleting middle message', async () => {
      const threadId = uuidv7()
      const msg1Id = uuidv7()
      const msg2Id = uuidv7()
      const msg3Id = uuidv7()
      const db = getDb()

      await db.insert(chatThreadsTable).values({
        id: threadId,
        title: 'Test Thread',
        isEncrypted: 0,
      })

      // Create chain: msg1 -> msg2 -> msg3
      await db.insert(chatMessagesTable).values([
        {
          id: msg1Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 1',
          parentId: null,
        },
        {
          id: msg2Id,
          chatThreadId: threadId,
          role: 'assistant',
          content: 'Message 2',
          parentId: msg1Id,
        },
        {
          id: msg3Id,
          chatThreadId: threadId,
          role: 'user',
          content: 'Message 3',
          parentId: msg2Id,
        },
      ])

      // Soft delete middle message and its descendants (DAL cascade)
      await deleteChatMessageAndDescendants(getDb(), msg2Id)

      // Only msg1 visible (msg2 and msg3 soft-deleted)
      const messages = await getChatMessages(getDb(), threadId)
      expect(messages).toHaveLength(1)
      expect(messages[0]?.id).toBe(msg1Id)
    })
  })

  describe('softDeleteChatMessages', () => {
    it('soft-deletes exactly the named messages and leaves their replies alone', async () => {
      const db = getDb()
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      const [first, second, third] = [uuidv7(), uuidv7(), uuidv7()]
      await db.insert(chatMessagesTable).values([
        { id: first, chatThreadId: threadId, role: 'user', content: 'one', parentId: null },
        { id: second, chatThreadId: threadId, role: 'assistant', content: 'two', parentId: first },
        { id: third, chatThreadId: threadId, role: 'user', content: 'three', parentId: second },
      ])

      await softDeleteChatMessages(db, [second])

      const live = await getChatMessages(db, threadId)
      expect(live.map((m) => m.id)).toEqual([first, third])
      const deleted = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, second)).get()
      expect(deleted?.deletedAt).not.toBeNull()
      expect(deleted?.content).toBeNull()
    })

    it('moves a live reply of a deleted message up to the nearest ancestor that stays', async () => {
      const db = getDb()
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      const [first, second, third, fourth] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()]
      await db.insert(chatMessagesTable).values([
        { id: first, chatThreadId: threadId, role: 'user', content: 'one', parentId: null },
        { id: second, chatThreadId: threadId, role: 'assistant', content: 'two', parentId: first },
        { id: third, chatThreadId: threadId, role: 'user', content: 'three', parentId: second },
        { id: fourth, chatThreadId: threadId, role: 'assistant', content: 'four', parentId: third },
      ])

      await softDeleteChatMessages(db, [second, third])

      const kept = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, fourth)).get()
      expect(kept?.parentId).toBe(first)
      // Deleting from the top still reaches it.
      await deleteChatMessageAndDescendants(db, first)
      expect(await getChatMessages(db, threadId)).toEqual([])
    })

    it('leaves the marker given on each row it deletes, and on no row that was already deleted', async () => {
      const db = getDb()
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      const [first, second] = [uuidv7(), uuidv7()]
      await db.insert(chatMessagesTable).values([
        { id: first, chatThreadId: threadId, role: 'user', content: 'one', parentId: null },
        { id: second, chatThreadId: threadId, role: 'assistant', content: 'two', parentId: first },
      ])
      await softDeleteChatMessages(db, [first])
      const marker = { alpha: { conversationId: 'c', messageId: 'm', dropped: true } }

      await softDeleteChatMessages(db, [first, second], new Map([first, second].map((id) => [id, marker])))

      const deleted = await db
        .select()
        .from(chatMessagesTable)
        .where(isNotNull(chatMessagesTable.deletedAt))
        .orderBy(chatMessagesTable.id)
      expect(deleted.map((r) => [r.id, r.metadata, r.content])).toEqual([
        [first, null, null],
        [second, marker, null],
      ])
    })
  })

  describe('restoreChatMessages', () => {
    it('brings a soft-deleted message back with its text and the parent given, and leaves a live row alone', async () => {
      const db = getDb()
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      const [first, second, live] = [uuidv7(), uuidv7(), uuidv7()]
      await db.insert(chatMessagesTable).values([
        { id: first, chatThreadId: threadId, role: 'user', content: 'one', parentId: null },
        { id: second, chatThreadId: threadId, role: 'assistant', content: 'two', parentId: first },
        { id: live, chatThreadId: threadId, role: 'assistant', content: 'kept', parentId: first },
      ])
      await softDeleteChatMessages(db, [second])
      const text = (id: string, value: string) =>
        ({ id, role: 'assistant', parts: [{ type: 'text', text: value }] }) as ThunderboltUIMessage

      await restoreChatMessages(db, threadId, [
        { message: text(second, 'two again'), parentId: first },
        { message: text(live, 'overwritten'), parentId: null },
      ])

      const rows = await getChatMessages(db, threadId)
      expect(rows.map((r) => [r.id, r.parentId, r.content])).toEqual([
        [first, null, 'one'],
        [second, first, 'two again'],
        [live, first, 'kept'],
      ])
    })
  })

  describe('saveChatMessagesWithParents', () => {
    it('leaves a row deleted meanwhile deleted, with no content written back into it', async () => {
      const db = getDb()
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      const reply = uuidv7()
      await db.insert(chatMessagesTable).values({ id: reply, chatThreadId: threadId, role: 'assistant', content: 'x' })
      await deleteChatMessageAndDescendants(db, reply)

      await saveChatMessagesWithParents(db, threadId, [
        {
          message: { id: reply, role: 'assistant', parts: [{ type: 'text', text: 'About an hour.' }] },
          parentId: null,
        },
      ])

      const row = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, reply)).get()
      expect([row?.deletedAt === null, row?.content, row?.parts]).toEqual([false, null, null])
    })

    it('places each message under the parent given, and leaves an existing row where it is', async () => {
      const db = getDb()
      const threadId = uuidv7()
      await db.insert(chatThreadsTable).values({ id: threadId, title: 'Test Thread', isEncrypted: 0 })
      const [first, second, later] = [uuidv7(), uuidv7(), uuidv7()]
      await db.insert(chatMessagesTable).values([
        { id: first, chatThreadId: threadId, role: 'user', content: 'one', parentId: null },
        { id: later, chatThreadId: threadId, role: 'user', content: 'later', parentId: first },
      ])
      const text = (id: string, value: string) =>
        ({ id, role: 'assistant', parts: [{ type: 'text', text: value }] }) as ThunderboltUIMessage

      await saveChatMessagesWithParents(db, threadId, [{ message: text(second, 'two'), parentId: first }])
      await saveChatMessagesWithParents(db, threadId, [{ message: text(later, 'edited'), parentId: second }])

      const rows = await getChatMessages(db, threadId)
      expect(rows.map((r) => [r.id, r.parentId])).toEqual([
        [first, null],
        [second, first],
        [later, first],
      ])
      expect(rows[2].parts).toEqual([{ type: 'text', text: 'edited' }])
    })
  })
})
