/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  applyMapWrites,
  chunkBatch,
  emptyIdMap,
  isEmptyBatch,
  mapWritesForAck,
  maxSkipRecords,
  planInbound,
  planOutbound,
  rejectedEntries,
  splitBatch,
  type IdMap,
  type LocalMessage,
  type LocalSnapshot,
  type LocalThread,
  type MapEntry,
} from './plan'
import { textHash } from './ids'
import { toInbound } from './map'
import type { InboundBatch, InboundMessage, OutboundBatch, OutboundMessage } from './provider'

/** Local ids sort by time; everything here is "after connecting" unless it sorts below this floor. */
const syncFrom = 'T0'
const opts = {
  isSettled: () => true,
  isStalled: () => false,
  createdAt: () => '2026-10-20T12:00:00.000Z',
  syncFrom,
  maxContentChars: 100,
}

const inMsg = (remoteId: string, localId: string, overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  remoteId,
  localId,
  isEcho: false,
  role: 'user',
  text: `text ${remoteId}`,
  createdAt: '2026-10-20T12:00:00.000Z',
  metadata: {},
  ...overrides,
})

const batch = (messages: InboundMessage[], overrides: Partial<InboundBatch['threads'][number]> = {}): InboundBatch => ({
  cursor: 'c',
  threads: [{ remoteId: 'conv-1', localId: 'T1', isEcho: false, title: 'Bread', messages, ...overrides }],
  tombstones: [],
})

const msg = (id: string, overrides: Partial<LocalMessage> = {}): LocalMessage => ({
  id,
  threadId: 'T1',
  role: 'user',
  text: 'hello',
  deletedAt: null,
  isStreaming: false,
  ...overrides,
})

const thread = (id: string, overrides: Partial<LocalThread> = {}): LocalThread => ({
  id,
  title: 'Chat',
  isEncrypted: 0,
  deletedAt: null,
  ...overrides,
})

const empty: LocalSnapshot = { threads: [], messages: [] }

const planIn = (b: InboundBatch, map: IdMap, local: LocalSnapshot) => planInbound(b, map, local, { syncFrom })

const mapWith = (entries: MapEntry[]): IdMap => {
  const map = emptyIdMap()
  applyMapWrites(map, entries)
  return map
}

/** Pretend the engine applied an inbound plan locally, then return the new snapshot. */
const applyLocally = (snapshot: LocalSnapshot, map: IdMap, b: InboundBatch): LocalSnapshot => {
  const plan = planIn(b, map, snapshot)
  applyMapWrites(map, plan.mapWrites)
  const threads = [...snapshot.threads, ...plan.createThreads.map((t) => thread(t.localId, { title: t.title }))]
  const deleted = new Set(plan.deleteMessages)
  // A drop writes its marker into the row's synced metadata with the delete, as `engine.ts` does.
  const dropped = new Set(plan.dropMessages.map((d) => d.localId))
  const restored = new Map(plan.restoreMessages.flatMap((g) => g.messages.map((m) => [m.localId, m.text] as const)))
  const messages = [
    ...snapshot.messages.map((m) =>
      deleted.has(m.id)
        ? { ...m, text: '', deletedAt: '2026-10-21T00:00:00.000Z', ...(dropped.has(m.id) ? { isDropped: true } : {}) }
        : restored.has(m.id)
          ? { ...m, text: restored.get(m.id) as string, deletedAt: null, isDropped: undefined }
          : m,
    ),
    ...plan.insertMessages.flatMap((g) =>
      g.messages.map((m) =>
        msg(m.localId, {
          threadId: g.threadLocalId,
          role: m.role,
          text: m.text,
          provenance: { conversationId: 'conv-1', messageId: m.remoteId },
        }),
      ),
    ),
  ]
  return { threads, messages }
}

describe('echo suppression', () => {
  it('never pushes back rows pulled from AI Potluck', () => {
    const map = emptyIdMap()
    const local = applyLocally(empty, map, batch([inMsg('m1', 'T1a'), inMsg('m2', 'T1b', { role: 'assistant' })]))
    const plan = planOutbound(local, map, opts)
    expect(isEmptyBatch(plan.batch)).toBe(true)
  })

  it('writes nothing the second time it sees the same pulled batch', () => {
    const map = emptyIdMap()
    const b = batch([inMsg('m1', 'T1a')])
    const local = applyLocally(empty, map, b)
    const again = planIn(b, map, local)
    expect(again).toMatchObject({ mapWrites: [], createThreads: [], insertMessages: [], updateMessages: [] })
  })

  it('maps a pushed row that comes back from AI Potluck instead of writing it again', () => {
    const local: LocalSnapshot = { threads: [thread('T1')], messages: [msg('T1a')] }
    const map = emptyIdMap()
    const out = planOutbound(local, map, opts)
    const { mapWrites } = mapWritesForAck(
      out.batch,
      {
        threads: [{ localId: 'T1', remoteId: 'conv-1' }],
        messages: [{ localId: 'T1a', remoteId: 'm1' }],
        rejected: [],
      },
      map,
    )
    applyMapWrites(map, mapWrites)
    const echo = batch([inMsg('m1', 'T1a', { isEcho: true, text: 'hello' })], { isEcho: true })
    const plan = planIn(echo, map, local)
    expect(plan).toMatchObject({ createThreads: [], insertMessages: [], updateMessages: [], deleteMessages: [] })
  })

  it('accepts an echo that arrives before the push answer, without writing it twice', () => {
    const local: LocalSnapshot = { threads: [thread('T1')], messages: [msg('T1a')] }
    const map = emptyIdMap()
    const echo = batch([inMsg('m1', 'T1a', { isEcho: true, text: 'hello' })], { isEcho: true })
    const plan = planIn(echo, map, local)
    expect(plan.insertMessages).toEqual([])
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'T1a', remoteId: 'm1', source: 'local' }))
  })

  it('skips a claim to a local id this device cannot confirm, so AI Potluck cannot address other rows by id', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1'), thread('P1', { isEncrypted: 1 })],
      messages: [msg('P1a', { threadId: 'P1' })],
    }
    const map = emptyIdMap()
    const unknownThread = planIn(
      batch([inMsg('m1', 'X1a', { isEcho: true })], { localId: 'X1', isEcho: true }),
      map,
      local,
    )
    const privateThread = planIn(batch([], { localId: 'P1', isEcho: true }), map, local)
    const otherThreadsMessage = planIn(batch([inMsg('m1', 'P1a', { isEcho: true })]), map, local)
    for (const plan of [unknownThread, privateThread, otherThreadsMessage]) {
      expect(plan.mapWrites.filter((e) => e.kind === 'message')).toEqual([])
      expect(plan.insertMessages).toEqual([])
      expect(plan.updateMessages).toEqual([])
    }
    expect(unknownThread.createThreads).toEqual([])
    expect(privateThread.mapWrites).toEqual([])
  })

  it('skips a claim to a chat from before connecting, even one that exists here, so AI Potluck cannot add turns to history', () => {
    // 'A0' sorts below syncFrom: the person started it before connecting, so it was never pushed.
    const local: LocalSnapshot = { threads: [thread('A0')], messages: [msg('A0a', { threadId: 'A0' })] }
    const plan = planIn(batch([inMsg('m1', 'A0b')], { localId: 'A0', isEcho: true }), emptyIdMap(), local)
    expect(plan.mapWrites).toEqual([])
    expect(plan.insertMessages).toEqual([])
  })
})

describe('provenance', () => {
  it('adopts rows another device pulled (they carry metadata.alpha) instead of pushing them', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1', { mintedFor: 'conv-1' })],
      messages: [
        msg('T1a', { provenance: { conversationId: 'conv-1', messageId: 'm1' } }),
        msg('T1b', { role: 'assistant', provenance: { conversationId: 'conv-1', messageId: 'm2' } }),
      ],
    }
    const map = emptyIdMap()
    const plan = planOutbound(local, map, opts)
    expect(isEmptyBatch(plan.batch)).toBe(true)
    expect(plan.mapWrites).toContainEqual(
      expect.objectContaining({ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote' }),
    )
    expect(plan.mapWrites).toContainEqual(
      expect.objectContaining({ kind: 'message', localId: 'T1b', remoteId: 'm2', source: 'remote' }),
    )
  })

  it('waits to adopt a chat until its title is decrypted, so ciphertext is never its agreed title', () => {
    const rows = [msg('T1a', { provenance: { conversationId: 'conv-1', messageId: 'm1' } })]
    const map = emptyIdMap()
    const early = planOutbound(
      { threads: [thread('T1', { mintedFor: 'conv-1', title: 'enc:xyz', isUndecrypted: true })], messages: rows },
      map,
      opts,
    )
    expect(early.mapWrites).toEqual([])
    expect(early.isHolding).toBe(true)
    const later = planOutbound(
      { threads: [thread('T1', { mintedFor: 'conv-1', title: 'Bread' })], messages: rows },
      map,
      opts,
    )
    expect(later.mapWrites).toContainEqual(
      expect.objectContaining({ kind: 'thread', localId: 'T1', remoteId: 'conv-1', title: 'Bread' }),
    )
  })

  it('adopts a thread whose id was not minted from the conversation as the person’s own, whatever its rows say', () => {
    // Its oldest row carries provenance (AI Potluck back-dated a turn into it), but the id decides.
    const local: LocalSnapshot = {
      threads: [thread('T1', { mintedFor: null })],
      messages: [msg('T1a', { provenance: { conversationId: 'conv-1', messageId: 'm0' } })],
    }
    const plan = planOutbound(local, emptyIdMap(), opts)
    expect(plan.mapWrites).toContainEqual(
      expect.objectContaining({ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'local' }),
    )
  })

  it('pushes the person’s own reply in an adopted thread under the existing conversation', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1', { mintedFor: 'conv-1' })],
      messages: [
        msg('T1a', { provenance: { conversationId: 'conv-1', messageId: 'm1' } }),
        msg('T1b', { text: 'mine' }),
      ],
    }
    const plan = planOutbound(local, emptyIdMap(), opts)
    expect(plan.batch.threads).toEqual([])
    expect(plan.batch.messages).toEqual([
      expect.objectContaining({ localId: 'T1b', threadRemoteId: 'conv-1', text: 'mine' }),
    ])
  })
})

describe('planOutbound', () => {
  it('uploads only chats started after connecting, not the history before it', () => {
    const local: LocalSnapshot = {
      threads: [thread('A1'), thread('T1')],
      messages: [msg('A1a', { threadId: 'A1' }), msg('T1a')],
    }
    const plan = planOutbound(local, emptyIdMap(), opts)
    expect(plan.batch.threads.map((t) => t.localId)).toEqual(['T1'])
    expect(plan.batch.messages.map((m) => m.localId)).toEqual(['T1a'])
  })

  it('keeps syncing a chat that was synced before, even when it is older than the connection', () => {
    const map = mapWith([{ kind: 'thread', localId: 'A1', remoteId: 'conv-0', source: 'local', title: 'Chat' }])
    const local: LocalSnapshot = { threads: [thread('A1')], messages: [msg('T9', { threadId: 'A1' })] }
    expect(planOutbound(local, map, opts).batch.messages).toEqual([
      expect.objectContaining({ localId: 'T9', threadRemoteId: 'conv-0' }),
    ])
  })

  it('never pushes a private chat or a row this device has not decrypted', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1', { isEncrypted: 1 }), thread('T2')],
      messages: [msg('T1a'), msg('T2a', { threadId: 'T2', isUndecrypted: true, text: '' })],
    }
    const plan = planOutbound(local, emptyIdMap(), opts)
    expect(isEmptyBatch(plan.batch)).toBe(true)
    expect(plan.isHolding).toBe(true)
  })

  it('never pushes a title this device has not decrypted, as a new chat or as a rename', () => {
    const map = mapWith([{ kind: 'thread', localId: 'T2', remoteId: 'conv-2', source: 'local', title: 'Old' }])
    const local: LocalSnapshot = {
      threads: [
        thread('T1', { title: '__enc:x', isUndecrypted: true }),
        thread('T2', { title: '__enc:y', isUndecrypted: true }),
      ],
      messages: [msg('T1a')],
    }
    const plan = planOutbound(local, map, opts)
    expect(plan.batch).toEqual({ threads: [], messages: [] })
    expect(plan.isHolding).toBe(true)
  })

  it('holds a reply that is still being written, and every later message in that chat with it', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1'), thread('T2')],
      messages: [
        msg('T1a'),
        msg('T1b', { role: 'assistant', isStreaming: true }),
        msg('T1c'),
        msg('T2a', { threadId: 'T2' }),
      ],
    }
    const plan = planOutbound(local, emptyIdMap(), { ...opts, isSettled: (m) => !m.isStreaming })
    expect(plan.batch.messages.map((m) => m.localId)).toEqual(['T1a', 'T2a'])
    expect(plan.isHolding).toBe(true)
  })

  it('records system, empty and over-long messages as not synced, and does not send them again', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1')],
      messages: [
        msg('T1a', { role: 'system' }),
        msg('T1b', { text: '  ' }),
        msg('T1c', { text: 'x'.repeat(101) }),
        msg('T1d'),
      ],
    }
    const map = emptyIdMap()
    const plan = planOutbound(local, map, opts)
    expect(plan.batch.messages.map((m) => m.localId)).toEqual(['T1d'])
    expect(plan.mapWrites.map((e) => [e.localId, e.rejected])).toEqual([
      ['T1a', 'unsupported-role'],
      ['T1b', 'empty'],
      ['T1c', 'too-large'],
    ])
    applyMapWrites(map, plan.mapWrites)
    expect(planOutbound(local, map, opts).batch.messages.map((m) => m.localId)).toEqual(['T1d'])
    expect(rejectedEntries(map)).toHaveLength(3)
  })

  it('skips an assistant reply with no text yet without recording it or holding the chat back, and sends it once it fills', () => {
    const local: LocalSnapshot = {
      threads: [thread('T1')],
      messages: [msg('T1a'), msg('T1b', { role: 'assistant', text: '' }), msg('T1c')],
    }
    const map = emptyIdMap()
    const plan = planOutbound(local, map, opts)
    expect(plan.batch.messages.map((m) => m.localId)).toEqual(['T1a', 'T1c'])
    expect(plan.mapWrites).toEqual([])
    // Planned again later, to send it once it fills or record it once it stalls.
    expect(plan.isHolding).toBe(true)
    const ack = {
      threads: plan.batch.threads.map((t) => ({ localId: t.localId, remoteId: `r-${t.localId}` })),
      messages: plan.batch.messages.map((m) => ({ localId: m.localId, remoteId: `r-${m.localId}` })),
      rejected: [],
    }
    applyMapWrites(map, mapWritesForAck(plan.batch, ack, map).mapWrites)
    const filled = { ...local, messages: [msg('T1b', { role: 'assistant', text: 'Done searching.' })] }
    expect(planOutbound(filled, map, opts).batch.messages.map((m) => m.localId)).toEqual(['T1b'])
  })

  it('pushes a rename and a delete of a mapped row once each', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'local', title: 'Old' },
      { kind: 'message', localId: 'T1a', remoteId: 'm1', source: 'local', threadLocalId: 'T1' },
    ])
    const local: LocalSnapshot = {
      threads: [thread('T1', { title: 'New' })],
      messages: [msg('T1a', { deletedAt: '2026-10-20T13:00:00.000Z' })],
    }
    const plan = planOutbound(local, map, opts)
    expect(plan.batch.threads).toEqual([expect.objectContaining({ localId: 'T1', remoteId: 'conv-1', title: 'New' })])
    expect(plan.batch.messages).toEqual([
      expect.objectContaining({ localId: 'T1a', remoteId: 'm1', deletedAt: expect.any(String) }),
    ])
    applyMapWrites(map, mapWritesForAck(plan.batch, { threads: [], messages: [], rejected: [] }, map).mapWrites)
    expect(isEmptyBatch(planOutbound(local, map, opts).batch)).toBe(true)
  })
})

describe('mapWritesForAck', () => {
  const pushed = (): OutboundBatch => ({
    threads: [{ localId: 'T1', remoteId: null, title: 'Chat', createdAt: 'x', deletedAt: null }],
    messages: ['T1a', 'T1b', 'T1c', 'T1d'].map(
      (id): OutboundMessage => ({
        localId: id,
        remoteId: null,
        threadLocalId: 'T1',
        threadRemoteId: null,
        role: 'user',
        text: id,
        createdAt: 'x',
        deletedAt: null,
      }),
    ),
  })

  it('maps acknowledged rows, records refused ones with the reason, and leaves the rest to send again', () => {
    const map = emptyIdMap()
    const { mapWrites, retryLater } = mapWritesForAck(
      pushed(),
      {
        threads: [{ localId: 'T1', remoteId: 'conv-1' }],
        messages: [{ localId: 'T1a', remoteId: 'm1' }],
        rejected: [
          { kind: 'message', localId: 'T1b', reason: 'content_too_long' },
          { kind: 'message', localId: 'T1c', reason: 'too_many_lookups' },
        ],
      },
      map,
    )
    applyMapWrites(map, mapWrites)
    expect(map.threads.get('T1')?.remoteId).toBe('conv-1')
    expect(map.messages.get('T1a')?.remoteId).toBe('m1')
    expect(map.messages.get('T1b')).toMatchObject({ remoteId: null, rejected: 'content_too_long' })
    // Transient: sent again later. Neither acknowledged nor refused: sent again on the next pass.
    expect(map.messages.has('T1c')).toBe(false)
    expect(map.messages.has('T1d')).toBe(false)
    expect(retryLater).toBe(true)
  })

  it('ends the mapping when AI Potluck no longer has a conversation the rename was for', () => {
    const map = mapWith([{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'local', title: 'Old' }])
    const rename: OutboundBatch = {
      threads: [{ localId: 'T1', remoteId: 'conv-1', title: 'New', createdAt: 'x', deletedAt: null }],
      messages: [],
    }
    const { mapWrites } = mapWritesForAck(
      rename,
      { threads: [], messages: [], rejected: [{ kind: 'thread', localId: 'T1', reason: 'not_found' }] },
      map,
    )
    expect(mapWrites).toEqual([expect.objectContaining({ localId: 'T1', deleted: true })])
  })
})

describe('planInbound', () => {
  it('keeps an unpushed local rename over the remote title', () => {
    const map = mapWith([{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Bread' }])
    const plan = planIn(batch([], { title: 'Sourdough' }), map, {
      threads: [thread('T1', { title: 'Mine' })],
      messages: [],
    })
    expect(plan.renameThreads).toEqual([])
  })

  it('applies a remote rename while the local title is still the agreed one', () => {
    const map = mapWith([{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Bread' }])
    const plan = planIn(batch([], { title: 'Sourdough' }), map, {
      threads: [thread('T1', { title: 'Bread' })],
      messages: [],
    })
    expect(plan.renameThreads).toEqual([{ localId: 'T1', title: 'Sourdough' }])
  })

  it('soft-deletes a pulled message that dropped off the remote’s live branch', () => {
    const map = emptyIdMap()
    const local = applyLocally(empty, map, batch([inMsg('m1', 'T1a'), inMsg('m2', 'T1b', { role: 'assistant' })]))
    const plan = planIn(batch([inMsg('m1', 'T1a'), inMsg('m3', 'T1c', { role: 'assistant' })]), map, local)
    expect(plan.deleteMessages).toEqual(['T1b'])
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'T1b', dropped: true }))
    expect(plan.mapWrites).not.toContainEqual(expect.objectContaining({ localId: 'T1b', deleted: true }))
  })

  it('restores a message that returns to the remote’s live branch, under the message before it', () => {
    const map = emptyIdMap()
    const q = inMsg('m1', 'T1a')
    const a1 = inMsg('m2', 'T1b', { role: 'assistant', text: 'first answer' })
    const a2 = inMsg('m3', 'T1c', { role: 'assistant', text: 'regenerated answer' })
    let local = applyLocally(empty, map, batch([q, a1]))
    local = applyLocally(local, map, batch([q, a2]))
    const plan = planIn(batch([q, a1]), map, local)
    expect(plan.deleteMessages).toEqual(['T1c'])
    expect(plan.insertMessages).toEqual([])
    expect(plan.restoreMessages).toEqual([
      {
        threadLocalId: 'T1',
        messages: [expect.objectContaining({ localId: 'T1b', text: 'first answer', parentId: 'T1a' })],
      },
    ])
    expect(plan.mapWrites.find((e) => e.localId === 'T1b')?.dropped).toBeUndefined()
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'T1c', dropped: true }))
  })

  it('keeps the last agreed title while the local one is undecrypted, so a rename there applies once it decrypts', () => {
    const map = mapWith([{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Bread' }])
    const undecrypted = planIn(batch([], { title: 'Rye' }), map, {
      threads: [thread('T1', { title: 'enc:xyz', isUndecrypted: true })],
      messages: [],
    })
    expect(undecrypted.renameThreads).toEqual([])
    applyMapWrites(map, undecrypted.mapWrites)
    expect(map.threads.get('T1')?.title).toBe('Bread')
    const decrypted = planIn(batch([], { title: 'Rye' }), map, {
      threads: [thread('T1', { title: 'Bread' })],
      messages: [],
    })
    expect(decrypted.renameThreads).toEqual([{ localId: 'T1', title: 'Rye' }])
  })

  it('reads a dropped row’s return from its synced marker, not from a map flag another device has made stale', () => {
    const q = inMsg('m1', 'T1a')
    const a1 = inMsg('m2', 'T1b', { role: 'assistant', text: 'first answer' })
    const map = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Bread' },
      {
        kind: 'message',
        localId: 'T1a',
        remoteId: 'm1',
        source: 'remote',
        threadLocalId: 'T1',
        hash: textHash('text m1'),
      },
      { kind: 'message', localId: 'T1b', remoteId: 'm2', source: 'remote', threadLocalId: 'T1', dropped: true },
    ])
    const deletedAt = '2026-10-21T00:00:00.000Z'
    const withA1 = (a1Row: LocalMessage): LocalSnapshot => ({
      threads: [thread('T1', { title: 'Bread' })],
      messages: [msg('T1a', { text: 'text m1' }), a1Row],
    })

    // Another device restored it, then the person deleted it: the delete cleared the marker.
    const personDeleted = planIn(batch([q, a1]), map, withA1(msg('T1b', { threadId: null, text: '', deletedAt })))
    expect(personDeleted.restoreMessages).toEqual([])
    expect(personDeleted.mapWrites).toContainEqual(expect.objectContaining({ localId: 'T1b', deleted: true }))

    // Not decrypted here yet: whose delete it was can't be read, so it waits.
    const unread = planIn(
      batch([q, a1]),
      map,
      withA1(msg('T1b', { threadId: null, text: '', deletedAt, isUndecrypted: true })),
    )
    expect(unread.restoreMessages).toEqual([])
    expect(unread.mapWrites.find((e) => e.localId === 'T1b')).toBeUndefined()

    // Still carrying the marker: dropped by a bridge, and back on the branch now.
    const marked = planIn(
      batch([q, a1]),
      map,
      withA1(msg('T1b', { threadId: null, text: '', deletedAt, isDropped: true })),
    )
    expect(marked.restoreMessages).toEqual([
      { threadLocalId: 'T1', messages: [expect.objectContaining({ localId: 'T1b', text: 'first answer' })] },
    ])
  })

  it('never restores a message the person deleted here, whether or not the delete was sent before the branch moved', () => {
    const q = inMsg('m1', 'T1a')
    const a1 = inMsg('m2', 'T1b', { role: 'assistant' })
    const a2 = inMsg('m3', 'T1c', { role: 'assistant' })
    const deleteHere = (snapshot: LocalSnapshot): LocalSnapshot => ({
      ...snapshot,
      messages: snapshot.messages.map((m) => (m.id === 'T1b' ? { ...m, deletedAt: '2026-10-21T00:00:00.000Z' } : m)),
    })

    // The delete was seen by a push pass first.
    const pushed = emptyIdMap()
    let local = deleteHere(applyLocally(empty, pushed, batch([q, a1])))
    applyMapWrites(pushed, planOutbound(local, pushed, opts).mapWrites)
    local = applyLocally(local, pushed, batch([q, a2]))
    expect(planIn(batch([q, a1]), pushed, local).restoreMessages).toEqual([])

    // The branch moved before any push pass saw the delete.
    const unpushed = emptyIdMap()
    local = deleteHere(applyLocally(empty, unpushed, batch([q, a1])))
    local = applyLocally(local, unpushed, batch([q, a2]))
    expect(unpushed.messages.get('T1b')).toMatchObject({ deleted: true })
    expect(planIn(batch([q, a1]), unpushed, local).restoreMessages).toEqual([])
  })

  it('does not insert an assistant reply AI Potluck has not written yet', () => {
    const plan = planIn(batch([inMsg('m1', 'T1a', { role: 'assistant', text: '' })]), emptyIdMap(), empty)
    expect(plan.insertMessages).toEqual([])
  })

  it('updates a pulled reply whose text AI Potluck changed, unless it was edited here or not yet decrypted', () => {
    const map = emptyIdMap()
    const local = applyLocally(empty, map, batch([inMsg('m1', 'T1a', { role: 'assistant', text: 'Draft' })]))
    const changed = batch([inMsg('m1', 'T1a', { role: 'assistant', text: 'Final answer' })])
    expect(planIn(changed, map, local).updateMessages).toEqual([
      { threadLocalId: 'T1', messages: [expect.objectContaining({ localId: 'T1a', text: 'Final answer' })] },
    ])
    const editedHere = { ...local, messages: local.messages.map((m) => ({ ...m, text: 'My edit' })) }
    expect(planIn(changed, map, editedHere).updateMessages).toEqual([])
    const undecrypted = { ...local, messages: local.messages.map((m) => ({ ...m, text: '', isUndecrypted: true })) }
    expect(planIn(changed, map, undecrypted).updateMessages).toEqual([])
  })

  it('lets a tombstone delete only rows that came from AI Potluck, never the person’s own', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'R1', remoteId: 'conv-r', source: 'remote', title: 'Theirs' },
      { kind: 'thread', localId: 'L1', remoteId: 'conv-l', source: 'local', title: 'Mine' },
      { kind: 'message', localId: 'L1a', remoteId: 'm-l', source: 'local', threadLocalId: 'L1' },
    ])
    const local: LocalSnapshot = { threads: [thread('R1'), thread('L1')], messages: [msg('L1a', { threadId: 'L1' })] }
    const plan = planIn(
      {
        cursor: 'c',
        threads: [],
        tombstones: [
          { kind: 'thread', remoteId: 'conv-r', deletedAt: 'x' },
          { kind: 'thread', remoteId: 'conv-l', deletedAt: 'x' },
          { kind: 'message', remoteId: 'm-l', deletedAt: 'x' },
        ],
      },
      map,
      local,
    )
    expect(plan.deleteThreads).toEqual(['R1'])
    expect(plan.deleteMessages).toEqual([])
    // The person's own chat stays, unmapped, so nothing more is sent for it.
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'L1', deleted: true }))
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'L1a', deleted: true }))
  })

  it('does not recreate a thread deleted here', () => {
    const map = mapWith([{ kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Bread' }])
    const plan = planIn(batch([inMsg('m9', 'T1z')]), map, {
      threads: [thread('T1', { deletedAt: '2026-10-20T13:00:00.000Z' })],
      messages: [],
    })
    expect(plan).toMatchObject({ createThreads: [], insertMessages: [] })
  })
})

describe('two devices and AI Potluck', () => {
  it('never pushes a delete for a message that came from AI Potluck, so a regenerate there keeps its other versions', () => {
    // Device A soft-deleted this reply when it left AI Potluck's live branch; PowerSync brought that
    // delete to device B before B's own pull did.
    const mapB = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Chat' },
      { kind: 'message', localId: 'T1a', remoteId: 'a1', source: 'remote', threadLocalId: 'T1', hash: 'x' },
    ])
    const local: LocalSnapshot = {
      threads: [thread('T1')],
      messages: [msg('T1a', { role: 'assistant', text: '', deletedAt: '2026-10-21T00:00:00.000Z' })],
    }
    const plan = planOutbound(local, mapB, opts)
    expect(plan.batch.messages).toEqual([])
    expect(plan.mapWrites).toEqual([expect.objectContaining({ localId: 'T1a', deleted: true })])
  })

  it('sends nothing and records nothing for a message this device dropped off AI Potluck’s live branch', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Chat' },
      { kind: 'message', localId: 'T1a', remoteId: 'a1', source: 'remote', threadLocalId: 'T1', dropped: true },
    ])
    const local: LocalSnapshot = {
      threads: [thread('T1')],
      messages: [msg('T1a', { role: 'assistant', text: '', deletedAt: '2026-10-21T00:00:00.000Z' })],
    }
    const plan = planOutbound(local, map, opts)
    expect(plan.batch.messages).toEqual([])
    expect(plan.mapWrites).toEqual([])
  })

  describe('deleting a whole chat', () => {
    const deletedAt = '2026-10-21T00:00:00.000Z'
    const setup = (source: 'remote' | 'local', deleteChoice?: 'everywhere' | 'here-only') => {
      const map = mapWith([
        { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source, title: 'Chat' },
        { kind: 'message', localId: 'T1a', remoteId: 'm-1', source: 'remote', threadLocalId: 'T1' },
        { kind: 'message', localId: 'T1x', remoteId: 'r-1', source: 'local', threadLocalId: 'T1' },
      ])
      const local: LocalSnapshot = {
        threads: [thread('T1', { deletedAt, ...(deleteChoice ? { deleteChoice } : {}) })],
        // A deleted message has lost its thread link.
        messages: [msg('T1a', { threadId: null, deletedAt }), msg('T1x', { threadId: null, deletedAt })],
      }
      return { map, plan: planOutbound(local, map, opts) }
    }

    it('sends one delete of the whole AI Potluck conversation when the person chose to delete it everywhere, and no message deletes', () => {
      const { plan } = setup('remote', 'everywhere')
      expect(plan.batch.threads).toEqual([expect.objectContaining({ localId: 'T1', remoteId: 'conv-1', deletedAt })])
      expect(plan.batch.messages).toEqual([])
      expect(plan.mapWrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ localId: 'T1a', deleted: true }),
          expect.objectContaining({ localId: 'T1x', deleted: true }),
        ]),
      )
    })

    it('sends nothing when the person chose to remove it from Thunderbolt only, wherever the chat started', () => {
      for (const source of ['remote', 'local'] as const) {
        const { plan } = setup(source, 'here-only')
        expect(plan.batch).toEqual({ threads: [], messages: [] })
        expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'T1', deleted: true }))
      }
    })

    it('without a choice (another device, or delete all), deletes a chat started here as one conversation delete and leaves an AI Potluck one', () => {
      const started = setup('local').plan
      expect(started.batch.threads).toEqual([expect.objectContaining({ localId: 'T1', remoteId: 'conv-1', deletedAt })])
      expect(started.batch.messages).toEqual([])
      expect(setup('remote').plan.batch).toEqual({ threads: [], messages: [] })
    })
  })

  it('sends no delete for a turn in an AI Potluck chat whose delete an earlier pass already recorded', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Chat', deleted: true },
      { kind: 'message', localId: 'T1x', remoteId: 'r-1', source: 'local', threadLocalId: 'T1' },
    ])
    const local: LocalSnapshot = { threads: [], messages: [msg('T1x', { threadId: null, deletedAt: 'x' })] }
    const plan = planOutbound(local, map, opts)
    expect(plan.batch.messages).toEqual([])
    expect(plan.mapWrites).toEqual([expect.objectContaining({ localId: 'T1x', deleted: true })])
  })

  it('still sends the delete of the person’s own turn in an AI Potluck chat that stays', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Chat' },
      { kind: 'message', localId: 'T1x', remoteId: 'r-1', source: 'local', threadLocalId: 'T1' },
    ])
    const local: LocalSnapshot = {
      threads: [thread('T1', { title: 'Chat' })],
      messages: [msg('T1x', { threadId: null, deletedAt: 'x' })],
    }
    expect(planOutbound(local, map, opts).batch.messages).toEqual([
      expect.objectContaining({ localId: 'T1x', remoteId: 'r-1', deletedAt: 'x' }),
    ])
  })

  it('never pushes a delete for a chat that came from AI Potluck, only one started here', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'T1', remoteId: 'conv-1', source: 'remote', title: 'Chat' },
      { kind: 'thread', localId: 'T2', remoteId: 'conv-2', source: 'local', title: 'Chat' },
    ])
    const deletedAt = '2026-10-21T00:00:00.000Z'
    const local: LocalSnapshot = { threads: [thread('T1', { deletedAt }), thread('T2', { deletedAt })], messages: [] }
    const plan = planOutbound(local, map, opts)
    expect(plan.batch.threads).toEqual([expect.objectContaining({ localId: 'T2', remoteId: 'conv-2', deletedAt })])
    expect(plan.mapWrites).toEqual([expect.objectContaining({ localId: 'T1', deleted: true })])
    applyMapWrites(map, plan.mapWrites)
    applyMapWrites(map, mapWritesForAck(plan.batch, { threads: [], messages: [], rejected: [] }, map).mapWrites)
    expect(isEmptyBatch(planOutbound(local, map, opts).batch)).toBe(true)
  })

  it('matches a pulled message to the row another device already wrote for it, instead of inserting a copy', () => {
    // The other device minted its id from an earlier createdAt; this device would mint another.
    const local: LocalSnapshot = {
      threads: [thread('T1', { title: 'Bread' })],
      messages: [msg('T1-old', { provenance: { conversationId: 'conv-1', messageId: 'm1' }, text: 'text m1' })],
    }
    const plan = planIn(batch([inMsg('m1', 'T1-new')]), emptyIdMap(), local)
    expect(plan.insertMessages).toEqual([])
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ localId: 'T1-old', remoteId: 'm1' }))
  })

  it('does not push a rename back when the local title is one AI Potluck itself sent recently', () => {
    const map = emptyIdMap()
    let local = applyLocally(empty, map, batch([inMsg('m1', 'T1a')], { title: 'First' }))
    const second = planIn(batch([inMsg('m1', 'T1a')], { title: 'Second' }), map, local)
    applyMapWrites(map, second.mapWrites)
    local = { ...local, threads: [thread('T1', { title: 'Second' })] }
    // PowerSync now delivers another device's late write of the older title.
    const late = { ...local, threads: [thread('T1', { title: 'First' })] }
    expect(planOutbound(late, map, opts).batch.threads).toEqual([])
    // A title nobody on AI Potluck sent is the person's own rename, and it is pushed.
    const mine = { ...local, threads: [thread('T1', { title: 'Mine' })] }
    expect(planOutbound(mine, map, opts).batch.threads).toEqual([expect.objectContaining({ title: 'Mine' })])
  })

  it('keeps a synced message on a device whose clock is days slow, rather than deleting it everywhere', async () => {
    const conversation = (now: number) =>
      toInbound(
        {
          v: 1,
          cursor: 'c',
          tombstones: [],
          conversations: [
            {
              id: 'conv-1',
              clientId: null,
              title: 'Bread',
              createdAt: '2026-10-20T12:00:00.000Z',
              updatedAt: '2026-10-22T12:00:00.000Z',
              messages: ['2026-10-20T12:00:01.000Z', '2026-10-22T12:00:00.000Z'].map((createdAt, i) => ({
                id: `m${i + 1}`,
                clientId: null,
                role: 'user' as const,
                content: `hi ${i}`,
                createdAt,
                origin: 'web',
              })),
            },
          ],
        },
        { clientId: 'thunderbolt-test', now },
      )
    // A device with a correct clock pulled both messages, and they reached this one through sync.
    const synced = (await conversation(Date.parse('2026-10-22T12:01:00.000Z'))).threads[0]
    const map = mapWith([
      { kind: 'thread', localId: synced.localId, remoteId: 'conv-1', source: 'remote', title: 'Bread' },
      ...synced.messages.map((m) => ({
        kind: 'message' as const,
        localId: m.localId,
        remoteId: m.remoteId,
        source: 'remote' as const,
        threadLocalId: synced.localId,
        hash: textHash(m.text),
      })),
    ])
    const local: LocalSnapshot = {
      threads: [thread(synced.localId, { title: 'Bread' })],
      messages: synced.messages.map((m) => msg(m.localId, { threadId: synced.localId, text: m.text })),
    }
    // This device's clock is two days slow, so the second message is too far ahead to place.
    const slow = await conversation(Date.parse('2026-10-20T12:01:00.000Z'))
    const plan = planIn(slow, map, local)
    expect(plan.deleteMessages).toEqual([])
    expect(plan.mapWrites.filter((w) => w.deleted)).toEqual([])
  })

  it('records an empty assistant reply as not synced once it has stalled, so empty replies never fill the page', () => {
    const local: LocalSnapshot = { threads: [thread('T1')], messages: [msg('T1a', { role: 'assistant', text: '' })] }
    expect(planOutbound(local, emptyIdMap(), opts).mapWrites).toEqual([])
    const stalled = planOutbound(local, emptyIdMap(), { ...opts, isStalled: () => true })
    expect(stalled.mapWrites).toEqual([expect.objectContaining({ localId: 'T1a', rejected: 'empty' })])
  })
})

describe('deleted conversations', () => {
  const tombstone = (remoteId: string): InboundBatch => ({
    cursor: 'c',
    threads: [],
    tombstones: [{ kind: 'thread', remoteId, deletedAt: 'x' }],
  })

  it('keeps an AI Potluck chat the person replied in: only AI Potluck’s messages go, and the chat stays unmapped', () => {
    const map = emptyIdMap()
    const pulled = applyLocally(empty, map, batch([inMsg('m1', 'T1a'), inMsg('m2', 'T1b', { role: 'assistant' })]))
    const local = { ...pulled, messages: [...pulled.messages, msg('T1c', { text: 'my follow-up' })] }
    const plan = planIn(tombstone('conv-1'), map, local)
    expect(plan.deleteThreads).toEqual([])
    expect(plan.deleteMessages.sort()).toEqual(['T1a', 'T1b'])
    expect(plan.mapWrites).toContainEqual(expect.objectContaining({ kind: 'thread', localId: 'T1', deleted: true }))
  })

  it('removes an AI Potluck chat that holds only AI Potluck’s messages', () => {
    const map = emptyIdMap()
    const local = applyLocally(empty, map, batch([inMsg('m1', 'T1a'), inMsg('m2', 'T1b', { role: 'assistant' })]))
    const plan = planIn(tombstone('conv-1'), map, local)
    expect(plan.deleteThreads).toEqual(['T1'])
  })

  it('in a chat started here, removes the messages that came from AI Potluck but never the chat', () => {
    const map = mapWith([
      { kind: 'thread', localId: 'L1', remoteId: 'conv-l', source: 'local', title: 'Mine' },
      { kind: 'message', localId: 'L1a', remoteId: 'm-a', source: 'local', threadLocalId: 'L1' },
      { kind: 'message', localId: 'L1b', remoteId: 'm-b', source: 'remote', threadLocalId: 'L1' },
    ])
    const local: LocalSnapshot = {
      threads: [thread('L1')],
      messages: [msg('L1a', { threadId: 'L1' }), msg('L1b', { threadId: 'L1', role: 'assistant' })],
    }
    const plan = planIn(tombstone('conv-l'), map, local)
    expect(plan.deleteThreads).toEqual([])
    expect(plan.deleteMessages).toEqual(['L1b'])
  })
})

describe('placing pulled messages', () => {
  it('parents each inserted message on the live message just before it by id, the order the chat shows', () => {
    const map = emptyIdMap()
    const pulled = applyLocally(empty, map, batch([inMsg('m1', 'T1a')]))
    // The person's reply (T1d) and AI Potluck's turn (T1b, T1c) happened at the same time.
    const local = { ...pulled, messages: [...pulled.messages, msg('T1d')] }
    const plan = planIn(
      batch([inMsg('m1', 'T1a'), inMsg('m2', 'T1b', { role: 'assistant' }), inMsg('m3', 'T1c')]),
      map,
      local,
    )
    expect(plan.insertMessages[0].messages.map((m) => [m.localId, m.parentId])).toEqual([
      ['T1b', 'T1a'],
      ['T1c', 'T1b'],
    ])
  })

  it('does not parent an inserted message on one the same batch deletes', () => {
    const map = emptyIdMap()
    const local = applyLocally(empty, map, batch([inMsg('m1', 'T1a'), inMsg('m2', 'T1b', { role: 'assistant' })]))
    const plan = planIn(batch([inMsg('m1', 'T1a'), inMsg('m3', 'T1c', { role: 'assistant' })]), map, local)
    expect(plan.deleteMessages).toEqual(['T1b'])
    expect(plan.insertMessages[0].messages).toEqual([expect.objectContaining({ localId: 'T1c', parentId: 'T1a' })])
  })
})

describe('skipped conversations', () => {
  it('records a conversation the event skipped as not synced, and clears the record once it arrives whole', () => {
    const map = emptyIdMap()
    const skipped = planIn(
      { cursor: 'c1', threads: [], tombstones: [], skipped: [{ remoteId: 'conv-1', reason: 'too-large' }] },
      map,
      empty,
    )
    applyMapWrites(map, skipped.mapWrites)
    expect(rejectedEntries(map)).toEqual([expect.objectContaining({ rejected: 'too-large' })])
    const local = applyLocally(empty, map, batch([inMsg('m1', 'T1a')]))
    expect(local.messages).toHaveLength(1)
    expect(rejectedEntries(map)).toEqual([])
  })

  it('marks a synced conversation whose latest version was skipped as not synced, keeping its mapping', () => {
    const map = emptyIdMap()
    applyLocally(empty, map, batch([inMsg('m1', 'T1a')]))
    const plan = planIn(
      { cursor: 'c2', threads: [], tombstones: [], skipped: [{ remoteId: 'conv-1', reason: 'unreadable' }] },
      map,
      empty,
    )
    expect(plan.mapWrites).toEqual([
      expect.objectContaining({ localId: 'T1', remoteId: 'conv-1', rejected: 'unreadable' }),
    ])
  })

  it('clears the not-synced record of a skipped conversation once AI Potluck deletes it', () => {
    const map = emptyIdMap()
    const skipped = planIn(
      { cursor: 'c1', threads: [], tombstones: [], skipped: [{ remoteId: 'conv-1', reason: 'too-large' }] },
      map,
      empty,
    )
    applyMapWrites(map, skipped.mapWrites)
    const deleted = planIn(
      { cursor: 'c2', threads: [], tombstones: [{ kind: 'thread', remoteId: 'conv-1', deletedAt: 'x' }] },
      map,
      empty,
    )
    applyMapWrites(map, deleted.mapWrites)
    expect(rejectedEntries(map)).toEqual([])
  })

  it('stops adding skip records at the cap and leaves the skip to the event’s replay instead', () => {
    const map = emptyIdMap()
    const skip = (cursor: string, ids: (string | null)[]) =>
      planIn(
        {
          cursor,
          threads: [],
          tombstones: [],
          skipped: ids.map((remoteId) => ({ remoteId, reason: 'unreadable' as const })),
        },
        map,
        empty,
      )
    const filling = skip(
      'c1',
      Array.from({ length: maxSkipRecords - 1 }, (_, i) => `bad-${i}`),
    )
    expect(filling).toMatchObject({ skipRecords: maxSkipRecords - 1, skippedEvent: false })
    applyMapWrites(map, filling.mapWrites)
    const past = skip('c2', ['bad-x', 'bad-y', 'bad-0'])
    // One more fits; the next is not recorded; one already recorded is rewritten, not added.
    expect(past.mapWrites.map((e) => e.localId)).toEqual(['skipped:bad-x', 'skipped:bad-0'])
    expect(past).toMatchObject({ skipRecords: 1, skippedEvent: true })
    applyMapWrites(map, past.mapWrites)
    expect(skip('c3', [null])).toMatchObject({ mapWrites: [], skipRecords: 0, skippedEvent: true })
    expect(map.threads.size).toBe(maxSkipRecords)
  })

  it('reports a skipped event, which no record names on its own, for Retry to read again', () => {
    const plan = planIn(
      { cursor: 'c1', threads: [], tombstones: [], skipped: [{ remoteId: null, reason: 'too-many' }] },
      emptyIdMap(),
      empty,
    )
    expect(plan).toMatchObject({ skipRecords: 1, skippedEvent: true })
    expect(plan.mapWrites.map((e) => e.localId)).toEqual(['skipped-event:c1'])
  })
})

describe('chunkBatch', () => {
  const big: OutboundBatch = {
    threads: Array.from({ length: 5 }, (_, i) => ({
      localId: `t${i}`,
      remoteId: null,
      title: 't',
      createdAt: 'x',
      deletedAt: null,
    })),
    messages: Array.from({ length: 12 }, (_, i) => ({
      localId: `m${i}`,
      remoteId: null,
      threadLocalId: `t${i % 5}`,
      threadRemoteId: null,
      role: 'user' as const,
      text: 'x',
      createdAt: 'x',
      deletedAt: null,
    })),
  }

  it('keeps every push within the server’s row and byte limits, and sends threads before messages', () => {
    const chunks = chunkBatch(big, { threads: 2, messages: 5, bytes: 1000 }, () => 100)
    for (const chunk of chunks) {
      expect(chunk.threads.length).toBeLessThanOrEqual(2)
      expect(chunk.messages.length).toBeLessThanOrEqual(5)
      expect((chunk.threads.length + chunk.messages.length) * 100).toBeLessThanOrEqual(1000)
    }
    const order = chunks.flatMap((c) => [...c.threads.map((t) => t.localId), ...c.messages.map((m) => m.localId)])
    expect(order).toEqual([...big.threads.map((t) => t.localId), ...big.messages.map((m) => m.localId)])
  })

  it('splits a batch in two halves that keep every row once', () => {
    const [a, b] = splitBatch(big)
    expect(a.threads.length + a.messages.length + b.threads.length + b.messages.length).toBe(17)
    expect(a.threads).toHaveLength(5)
  })
})
