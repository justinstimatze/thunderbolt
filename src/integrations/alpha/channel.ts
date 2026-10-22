/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { EngineStatus } from './engine'

/*
 * One tab per browser runs the bridge (see `locks.ts`). The others learn its status, and ask it to
 * retry, over a BroadcastChannel; every tab hears when the connection changes.
 */

export type AlphaChannelMessage =
  | { type: 'status'; status: EngineStatus | null }
  /** Retry now, and send again the rows AI Potluck refused. */
  | { type: 'retry' }
  | { type: 'connection-changed' }
  /** A tab that just opened asks the running bridge for its status. */
  | { type: 'hello' }

const channelName = 'alpha-sync'

/** Listen for messages from this browser's other tabs; returns the unsubscribe. */
export const listenToAlphaChannel = (onMessage: (message: AlphaChannelMessage) => void): (() => void) => {
  if (typeof BroadcastChannel === 'undefined') {
    return () => {}
  }
  const channel = new BroadcastChannel(channelName)
  channel.onmessage = (event: MessageEvent<AlphaChannelMessage>) => onMessage(event.data)
  return () => channel.close()
}

/** Tell this browser's other tabs (never this one). */
export const postToAlphaChannel = (message: AlphaChannelMessage): void => {
  if (typeof BroadcastChannel === 'undefined') {
    return
  }
  const channel = new BroadcastChannel(channelName)
  channel.postMessage(message)
  channel.close()
}
