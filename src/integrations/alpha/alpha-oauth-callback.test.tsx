/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { act, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import { DatabaseProvider } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import AlphaOAuthCallback from './alpha-oauth-callback'
import { useAlphaSyncStore } from './store'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('AlphaOAuthCallback', () => {
  it('runs the callback once, announcing one connection change, when StrictMode runs its effect twice', async () => {
    const before = useAlphaSyncStore.getState().connectionVersion
    const { unmount } = render(
      <StrictMode>
        <DatabaseProvider db={getDb()}>
          <MemoryRouter initialEntries={['/oauth/alpha/callback?code=c&state=s']}>
            <AlphaOAuthCallback />
          </MemoryRouter>
        </DatabaseProvider>
      </StrictMode>,
    )
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await getClock().tickAsync(10)
        await new Promise((resolve) => setImmediate(resolve))
      })
    }
    expect(useAlphaSyncStore.getState().connectionVersion).toBe(before + 1)
    unmount()
  })
})
