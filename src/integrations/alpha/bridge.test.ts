/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { syncEnabledChangeEvent } from '@/db/powersync/sync-state'
import { waitForChatRows } from './bridge'

/** A PowerSync whose first sync never finishes until its signal aborts. */
const neverSynced = () => ({
  waitForFirstSync: ({ signal }: { signal?: AbortSignal } = {}) =>
    new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true })),
})

describe('waitForChatRows', () => {
  it('fails, so the engine does not start without the rows, when sync is turned off before they arrive', async () => {
    let isEnabled = true
    const waiting = waitForChatRows(new AbortController().signal, {
      powerSync: neverSynced(),
      isEnabled: () => isEnabled,
    }).then(
      () => 'resolved',
      () => 'rejected',
    )
    isEnabled = false
    window.dispatchEvent(new CustomEvent(syncEnabledChangeEvent, { detail: false }))
    expect(await waiting).toBe('rejected')
  })

  it('resolves at once when sync is off from the start, since every row this device has is already here', async () => {
    await waitForChatRows(new AbortController().signal, { powerSync: neverSynced(), isEnabled: () => false })
  })

  it('resolves when the first sync finishes', async () => {
    await waitForChatRows(new AbortController().signal, {
      powerSync: { waitForFirstSync: async () => {} },
      isEnabled: () => true,
    })
  })
})
