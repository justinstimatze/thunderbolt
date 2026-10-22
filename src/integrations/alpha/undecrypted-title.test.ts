/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { applyMapWrites, emptyIdMap, planInbound, type IdMap, type LocalSnapshot, type LocalThread } from './plan'
import type { InboundBatch, InboundMessage } from './provider'

const syncFrom = 'T0'

const batch = (messages: InboundMessage[], overrides: Partial<InboundBatch['threads'][number]> = {}): InboundBatch => ({
  cursor: 'c',
  threads: [{ remoteId: 'conv-1', localId: 'T1', isEcho: false, title: 'Bread', messages, ...overrides }],
  tombstones: [],
})

const thread = (id: string, overrides: Partial<LocalThread> = {}): LocalThread => ({
  id,
  title: 'Chat',
  isEncrypted: 0,
  deletedAt: null,
  ...overrides,
})

const planIn = (b: InboundBatch, map: IdMap, local: LocalSnapshot) => planInbound(b, map, local, { syncFrom })

describe('a chat title not decrypted yet', () => {
  it('a remote rename applies after the thread title decrypts on a device that first mapped it undecrypted', () => {
    const map = emptyIdMap()
    // The chat arrived through Thunderbolt's sync (another browser created it) but is not decrypted yet.
    const first = planIn(batch([], { title: 'Bread' }), map, {
      threads: [thread('T1', { title: 'enc:xyz', isUndecrypted: true })],
      messages: [],
    })
    applyMapWrites(map, first.mapWrites)
    // (ciphertext stored as agreed title)
    // Decrypted now; AI Potluck renames it.
    const second = planIn(batch([], { title: 'Sourdough' }), map, {
      threads: [thread('T1', { title: 'Bread' })],
      messages: [],
    })
    expect(second.renameThreads).toEqual([{ localId: 'T1', title: 'Sourdough' }])
  })
})
