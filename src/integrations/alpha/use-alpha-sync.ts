/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { useDatabase } from '@/contexts'
import { isTauri } from '@/lib/platform'
import { listenToAlphaChannel, postToAlphaChannel } from './channel'
import { alphaConfig, type AlphaConfig } from './config'
import type { EngineControls, EngineStatus } from './engine'
import type { SyncError } from './errors'
import { engineLockName, withLock } from './locks'
import { getConnectionState } from './storage'
import { useAlphaSyncStore } from './store'

/** The running bridge's controls, when this tab is the one running it. */
let activeControls: EngineControls | null = null
let activeStatus: EngineStatus | null = null
/** This tab's bridge stopped on an error. Nothing restarts it on its own; Retry does. */
let crashed = false

/** The card shows a stop the engine named itself (a `SyncError`); anything else is `unknown`. */
const failedStatus = (error: unknown): EngineStatus => {
  // Matched by name: importing `errors.ts` here would pull its dependencies into the entry bundle.
  const code = error instanceof Error && error.name === 'SyncError' ? (error as SyncError).code : 'unknown'
  const loop = { state: 'paused' as const, error: code, nextRetryAt: null, lastOkAt: null }
  return { pull: loop, push: { ...loop }, notSynced: 0 }
}

/** Retry now and send the refused rows again, in whichever tab runs the bridge. */
export const retryAlphaSync = (): void => {
  if (activeControls) {
    void activeControls.retryRejected()
  } else if (crashed) {
    useAlphaSyncStore.getState().bumpConnection()
  } else {
    postToAlphaChannel({ type: 'retry' })
  }
}

/** Tell every tab, this one included, that the connection changed. */
export const announceAlphaConnectionChange = (): void => {
  useAlphaSyncStore.getState().bumpConnection()
  postToAlphaChannel({ type: 'connection-changed' })
}

/** Seams for tests; the app passes none. */
type AlphaSyncDeps = {
  /** The configured AI Potluck server, or null when this build has none. */
  config?: AlphaConfig | null
  runBridge?: (typeof import('./bridge'))['runAlphaBridge']
}

/**
 * App-level hook (mounted in AppContent beside `useMcpSync`) that runs the AI Potluck bridge while
 * this device is connected. Only one tab per browser runs it, under a Web Lock; when that tab
 * closes, a waiting tab takes over. The engine itself loads only once a connection exists.
 *
 * The desktop and mobile apps are left out: their OAuth redirect is not wired up yet.
 */
export const useAlphaSync = ({ config: configOverride, runBridge }: AlphaSyncDeps = {}) => {
  const db = useDatabase()
  const connectionVersion = useAlphaSyncStore((s) => s.connectionVersion)

  useEffect(
    () =>
      listenToAlphaChannel((message) => {
        const { setEngine, bumpConnection } = useAlphaSyncStore.getState()
        if (message.type === 'status' && !activeControls) {
          setEngine(message.status)
        } else if (message.type === 'retry') {
          if (activeControls) {
            void activeControls.retryRejected()
          } else if (crashed) {
            bumpConnection()
          }
        } else if (message.type === 'connection-changed') {
          bumpConnection()
        } else if (message.type === 'hello' && activeControls) {
          postToAlphaChannel({ type: 'status', status: activeStatus })
        }
      }),
    [],
  )

  useEffect(() => {
    const { setConnection, setEngine } = useAlphaSyncStore.getState()
    const config = configOverride !== undefined ? configOverride : alphaConfig.ok ? alphaConfig.config : null
    if (isTauri() || !config) {
      setConnection({ status: 'none' })
      return
    }
    const controller = new AbortController()
    const { signal } = controller

    const publish = (status: EngineStatus | null) => {
      activeStatus = status
      setEngine(status)
      postToAlphaChannel({ type: 'status', status })
    }

    const run = async () => {
      const connection = await getConnectionState(db, config.origin)
      setConnection(connection)
      if (connection.status !== 'connected') {
        setEngine(null)
        return
      }
      postToAlphaChannel({ type: 'hello' })
      await withLock(
        engineLockName,
        async () => {
          // Another tab may have disconnected while this one waited for the lock.
          if (signal.aborted || (await getConnectionState(db, config.origin)).status !== 'connected') {
            return
          }
          const runAlphaBridge = runBridge ?? (await import('./bridge')).runAlphaBridge
          crashed = false
          try {
            await runAlphaBridge(
              {
                db,
                config,
                onStatus: publish,
                onControls: (controls) => {
                  activeControls = controls
                },
                onSignedOut: announceAlphaConnectionChange,
              },
              signal,
            )
          } catch (error) {
            console.error('AI Potluck sync stopped', error)
            crashed = true
            publish(failedStatus(error))
            return
          } finally {
            activeControls = null
          }
          publish(null)
        },
        signal,
      )
    }

    run().catch((error: unknown) => {
      if (!signal.aborted) {
        console.error('AI Potluck sync could not start', error)
      }
    })
    return () => controller.abort()
  }, [db, connectionVersion, configOverride, runBridge])
}
