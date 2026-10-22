/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { ReactNode } from 'react'
import { DatabaseProvider } from '@/contexts'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import type { AlphaConfig } from './config'
import { SyncError } from './errors'
import { saveAlphaConnection } from './storage'
import { useAlphaSyncStore } from './store'
import { teardownAlphaSync } from './teardown'
import { retryAlphaSync, useAlphaSync } from './use-alpha-sync'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const config: AlphaConfig = { origin: 'https://alpha.example', clientId: 'thunderbolt-test' }

beforeEach(async () => {
  await resetTestDatabase()
  await saveAlphaConnection(getDb(), {
    origin: config.origin,
    metadata: {
      issuer: config.origin,
      authorization_endpoint: `${config.origin}/authorize`,
      token_endpoint: `${config.origin}/token`,
      response_types_supported: ['code'],
    } as AuthorizationServerMetadata,
    credentials: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: null },
  })
})

const wrapper = ({ children }: { children: ReactNode }) => <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await getClock().tickAsync(10)
      await new Promise((resolve) => setImmediate(resolve))
    })
  }
}

describe('useAlphaSync', () => {
  it('starts the bridge again when the person presses Retry after it stopped on an error', async () => {
    let runs = 0
    const runBridge = async () => {
      runs += 1
      if (runs === 1) {
        throw new Error('engine crashed')
      }
    }
    const { unmount } = renderHook(() => useAlphaSync({ config, runBridge }), { wrapper })
    await flush()
    expect(runs).toBe(1)
    expect(useAlphaSyncStore.getState().engine?.pull.state).toBe('paused')
    act(() => retryAlphaSync())
    await flush()
    expect(runs).toBe(2)
    unmount()
  })

  it('shows the reason the bridge gave for stopping, so a failure to load local chats is not reported as unknown', async () => {
    const runBridge = async () => {
      throw new SyncError('paused', 'local-data')
    }
    const { unmount } = renderHook(() => useAlphaSync({ config, runBridge }), { wrapper })
    await flush()
    expect(useAlphaSyncStore.getState().engine?.pull).toMatchObject({ state: 'paused', error: 'local-data' })
    unmount()
  })
})

describe('teardownAlphaSync', () => {
  it('tells this tab’s own bridge that the connection changed, not only the other tabs', async () => {
    const before = useAlphaSyncStore.getState().connectionVersion
    await teardownAlphaSync()
    expect(useAlphaSyncStore.getState().connectionVersion).toBe(before + 1)
  })
})
