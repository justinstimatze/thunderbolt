/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { create } from 'zustand'
import type { ConnectErrorCode } from './connect'
import type { EngineStatus } from './engine'
import type { ConnectionState } from './storage'

type AlphaSyncState = {
  /** This device's connection, or null until it has been read. */
  connection: ConnectionState | null
  /** The bridge's status, from whichever tab of this browser runs it; null while none does. */
  engine: EngineStatus | null
  /** Why the last attempt to connect failed. */
  connectError: ConnectErrorCode | null
  /** Bumped on Connect, Disconnect and sign-out so the app-level hook re-reads the connection. */
  connectionVersion: number
  setConnection: (connection: ConnectionState | null) => void
  setEngine: (engine: EngineStatus | null) => void
  setConnectError: (code: ConnectErrorCode | null) => void
  bumpConnection: () => void
}

/** Shared between the app-level sync hook and the Connections card. */
export const useAlphaSyncStore = create<AlphaSyncState>()((set) => ({
  connection: null,
  engine: null,
  connectError: null,
  connectionVersion: 0,
  setConnection: (connection) => set({ connection }),
  setEngine: (engine) => set({ engine }),
  setConnectError: (connectError) => set({ connectError }),
  bumpConnection: () => set((s) => ({ connectionVersion: s.connectionVersion + 1 })),
}))
