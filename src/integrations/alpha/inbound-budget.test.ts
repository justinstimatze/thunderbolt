/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The day's inbound budget: what AI Potluck may write here in 24 hours, and what still applies once
// it is spent.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { eq, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, modelsTable } from '@/db/tables'
import { getClock } from '@/testing-library'
import { applyInboundWithinBudget, runSyncEngine, type EngineStatus, type InboundBudget } from './engine'
import { uuidv7Floor } from './ids'
import { toInbound, type ChangesEventV1 } from './map'
import type { ExternalSyncProvider, InboundBatch, PushAck } from './provider'
import { getMeta, loadIdMap, metaKeys } from './storage'

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

const threadRow = (id: string) => getDb().select().from(chatThreadsTable).where(eq(chatThreadsTable.id, id)).get()

describe('inbound budget', () => {
  it('counts the characters AI Potluck writes into existing replies against the day’s character budget', async () => {
    const db = getDb()
    const budget: InboundBudget = { chats: 100, messages: 100, chars: 1000 }
    const at = Date.parse('2026-10-21T08:00:00.000Z')
    const apply = async (cursor: string, content: string) =>
      applyInboundWithinBudget(
        db,
        await loadIdMap(db),
        await toInbound(
          event({ cursor, conversations: [conversation('conv-1', [question, { ...answer, content }])] }),
          ctx,
        ),
        { syncFrom },
        { budget, at },
      )
    await apply('c1', 'short')
    // Each fill-in is 150,000 characters, 150x the whole day's budget. Every one is stored and
    // uploaded by Thunderbolt's own sync.
    const outcomes: unknown[] = []
    for (let i = 0; i < 3; i++) {
      outcomes.push(
        await apply(`c${i + 2}`, String(i).repeat(150_000)).then(
          () => 'applied',
          (e: unknown) => e,
        ),
      )
    }
    const use = JSON.parse((await getMeta(db, metaKeys.inboundUse)) ?? 'null')
    // Contract (README): once 100M (here 1000) characters were added in 24 hours, a change that
    // would add more waits.
    const stored = await getDb().select().from(chatMessagesTable).where(isNull(chatMessagesTable.deletedAt))
    const storedChars = stored.reduce((sum, r) => sum + (r.content?.length ?? 0), 0)
    expect({ outcomes, countedChars: use?.chars, storedChars }).toEqual({
      outcomes: ['applied', expect.anything(), expect.anything()],
      countedChars: expect.any(Number),
      storedChars: expect.any(Number),
    })
    expect(outcomes.slice(1).every((o) => o !== 'applied')).toBe(true)
  })

  it('while the pull is paused on the budget, a later delete from AI Potluck still applies, and the cursor waits', async () => {
    const budget: InboundBudget = { chats: 1, messages: 1000, chars: 1_000_000 }
    const batches: InboundBatch[] = [
      await toInbound(event({ cursor: 'c1', conversations: [conversation('conv-1', [question])] }), ctx),
      await toInbound(
        event({ cursor: 'c2', conversations: [conversation('conv-2', [{ ...question, id: 'x1' }])] }),
        ctx,
      ),
      await toInbound(
        event({
          cursor: 'c3',
          tombstones: [{ kind: 'conversation', id: 'conv-1', clientId: null, deletedAt: '2026-10-20T13:00:00.000Z' }],
        }),
        ctx,
      ),
    ]
    const statuses: EngineStatus[] = []
    const controller = new AbortController()
    let opened = 0
    const provider: ExternalSyncProvider = {
      id: 'alpha',
      changes: async function* (cursor, signal) {
        opened += 1
        const from = cursor === null ? 0 : batches.findIndex((b) => b.cursor === cursor) + 1
        yield* batches.slice(from)
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      push: async (): Promise<PushAck> => ({ threads: [], messages: [], rejected: [] }),
    }
    const done = runSyncEngine(
      {
        db: getDb(),
        provider,
        syncFrom,
        onStatus: (s) => statuses.push(s),
        settleMs: 20,
        stalledMs: 500,
        firstPushDelayMs: 50,
        inboundBudget: budget,
        random: () => 0,
      },
      () => () => {},
      controller.signal,
    )
    const conv1Row = async () => {
      const conv1 = (await loadIdMap(getDb())).threadsByRemote.get('conv-1')
      return conv1 ? threadRow(conv1.localId) : undefined
    }
    // Wait for the pause, then for the later delete (or give up after a bounded number of steps).
    for (let i = 0; i < 300; i++) {
      if (statuses.at(-1)?.pull.state === 'paused' && (await conv1Row())?.deletedAt) {
        break
      }
      await getClock().tickAsync(10)
      await new Promise((resolve) => setImmediate(resolve))
    }
    controller.abort()
    await done
    expect(statuses.at(-1)?.pull.error).toBe('inbound-limit')
    expect(opened).toBe(1)
    const row = await conv1Row()
    // README: "Renames and deletes still apply meanwhile."
    expect({ cursor: await getMeta(getDb(), metaKeys.cursor), deleted: row?.deletedAt !== null }).toEqual({
      cursor: 'c1',
      deleted: true,
    })
  })

  it('once the budget is spent, a rewrite of an existing reply waits like an addition, and so does a rename', async () => {
    const db = getDb()
    const roomy = { budget: { chats: 10, messages: 10, chars: 10_000_000 }, at: Date.now() }
    const spent = { budget: { chats: 0, messages: 0, chars: 0 }, at: Date.now() }
    const batch = async (
      cursor: string,
      messages: ChangesEventV1['conversations'][number]['messages'],
      title?: string,
    ) => toInbound(event({ cursor, conversations: [conversation('conv-1', messages, title)] }), ctx)
    const apply = async (b: InboundBatch, limits: typeof roomy) =>
      applyInboundWithinBudget(db, await loadIdMap(db), b, { syncFrom }, limits)
    await apply(await batch('c1', [question, { ...answer, content: 'first' }]), roomy)
    const useBefore = await getMeta(db, metaKeys.inboundUse)

    // A new message is refused while the budget is spent...
    const grow = await batch('c2', [question, { ...answer, content: 'first' }, { ...answer, id: 'm3' }])
    await expect(apply(grow, spent)).rejects.toThrow('inbound-limit')
    // ...and so is rewriting the reply with 200,000 characters, or renaming the chat.
    const rewrite = await batch('c3', [question, { ...answer, content: 'a'.repeat(200_000) }])
    await expect(apply(rewrite, spent)).rejects.toThrow('inbound-limit')
    await expect(apply(await batch('c4', [question, { ...answer, content: 'first' }], 'Rye'), spent)).rejects.toThrow(
      'inbound-limit',
    )
    const replies = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.role, 'assistant'))
    expect(replies.map((r) => r.content)).toEqual(['first'])
    expect(await getMeta(db, metaKeys.inboundUse)).toBe(useBefore)

    // With room, the rewrite applies and its whole text counts toward the day.
    await apply(rewrite, roomy)
    const charsOf = (use: string | null) => (JSON.parse(use ?? 'null') as { chars: number }).chars
    expect(charsOf(await getMeta(db, metaKeys.inboundUse)) - charsOf(useBefore)).toBe(200_000)
  })
})
