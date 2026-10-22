/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PowerSyncDatabase } from '@powersync/web'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getPowerSyncInstance, isSyncEnabled, syncEnabledChangeEvent } from '@/db/powersync/sync-state'
import { createAlphaProvider } from './alpha-provider'
import type { AlphaConfig } from './config'
import { settleSyncFrom } from './connect'
import { runSyncEngine, type EngineControls, type EngineStatus } from './engine'
import { uuidv7Floor } from './ids'
import { createOpenChatRefresher } from './refresh-open-chats'
import { forgetAlphaCredentials } from './storage'

/*
 * The part of the bridge that only loads once this device is connected: the engine, the provider,
 * the wire schemas and the stream parser stay out of the bundle of everyone who never connects.
 */

const watchedTables = ['chat_threads', 'chat_messages']
/** Without a change feed, look for local changes this often (each look reads only unsynced rows). */
const fallbackPollMs = 15_000

/** Local chat-table changes, from PowerSync's change feed (rows synced in from other devices included). */
const subscribeToChatTables = (onChange: () => void): (() => void) => {
  const powerSync = getPowerSyncInstance()
  if (!powerSync) {
    const timer = setInterval(onChange, fallbackPollMs)
    return () => clearInterval(timer)
  }
  return powerSync.onChange({ onChange }, { tables: watchedTables, throttleMs: 300 })
}

/**
 * Resolves once PowerSync has downloaded everything this device is owed, every priority (the app
 * itself waits only for priority 1, which leaves chat messages still arriving). Without sync turned
 * on there is nothing to wait for. Turning it off mid-wait rejects, so the engine stops with a
 * `local-data` error instead of starting without the rows; Retry starts it again.
 */
export const waitForChatRows = async (
  signal: AbortSignal,
  {
    powerSync = getPowerSyncInstance(),
    isEnabled = isSyncEnabled,
  }: { powerSync?: Pick<PowerSyncDatabase, 'waitForFirstSync'> | null; isEnabled?: () => boolean } = {},
): Promise<void> => {
  if (!powerSync || !isEnabled()) {
    return
  }
  const done = new AbortController()
  let turnedOff = false
  const onToggle = () => {
    if (!isEnabled()) {
      turnedOff = true
      done.abort()
    }
  }
  window.addEventListener(syncEnabledChangeEvent, onToggle)
  try {
    const both = AbortSignal.any([signal, done.signal])
    await Promise.race([
      powerSync.waitForFirstSync({ signal: both }),
      new Promise<void>((resolve) => both.addEventListener('abort', () => resolve(), { once: true })),
    ])
  } finally {
    window.removeEventListener(syncEnabledChangeEvent, onToggle)
    done.abort()
  }
  if (turnedOff && !signal.aborted) {
    throw new Error("Sync was turned off before this device's chats finished loading")
  }
}

type BridgeOptions = {
  db: AnyDrizzleDatabase
  config: AlphaConfig
  onStatus: (status: EngineStatus) => void
  onControls: (controls: EngineControls) => void
  onSignedOut: () => void
}

/** Run the AI Potluck bridge in this tab until `signal` aborts or AI Potluck signs the device out. */
export const runAlphaBridge = async (
  { db, config, onStatus, onControls, onSignedOut }: BridgeOptions,
  signal: AbortSignal,
): Promise<void> => {
  const refreshOpen = createOpenChatRefresher(db)
  await runSyncEngine(
    {
      db,
      provider: createAlphaProvider({ db, config }),
      // Settled once this device's chat rows have loaded: the window another browser shares may
      // arrive with them.
      syncFrom: async () => uuidv7Floor(await settleSyncFrom(db, config.origin)),
      onStatus,
      onControls,
      // An open chat shows its in-memory copy; have it read what the batch wrote.
      onInboundApplied: (threads) => {
        void refreshOpen(threads)
      },
      waitForLocalData: waitForChatRows,
      onSignedOut: async () => {
        await forgetAlphaCredentials(db)
        onSignedOut()
      },
    },
    subscribeToChatTables,
    signal,
  )
}
