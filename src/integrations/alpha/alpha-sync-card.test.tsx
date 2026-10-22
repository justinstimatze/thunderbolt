/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DatabaseProvider } from '@/contexts'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { AlphaSyncCard, AlphaSyncCardView, worstLoop, type AlphaSyncCardActions } from './alpha-sync-card'
import { alphaConfig } from './config'
import { ConnectError } from './connect'
import type { EngineStatus, LoopStatus } from './engine'
import { useAlphaSyncStore } from './store'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

const config = { origin: 'https://potluck.example', clientId: 'client-1' }

const loop = (overrides: Partial<LoopStatus> = {}): LoopStatus => ({
  state: 'ok',
  error: null,
  nextRetryAt: null,
  lastOkAt: null,
  ...overrides,
})

const status = (pull: Partial<LoopStatus> = {}, push: Partial<LoopStatus> = {}, notSynced = 0): EngineStatus => ({
  pull: loop(pull),
  push: loop(push),
  notSynced,
})

const fakeActions = () => ({
  connect: mock(async () => {}),
  disconnect: mock(async () => {}),
  retry: mock(() => {}),
  announceConnectionChange: mock(() => {}),
})

const renderView = (actions: AlphaSyncCardActions) =>
  render(
    <DatabaseProvider db={getDb()}>
      <AlphaSyncCardView config={config} actions={actions} />
    </DatabaseProvider>,
  )

const statusText = () => screen.queryByTestId('alpha-sync-status')?.textContent ?? null
const button = (name: string) => screen.queryByRole('button', { name })

describe('AlphaSyncCard', () => {
  it('renders nothing in a build with no AI Potluck server, rather than build instructions its users cannot act on', () => {
    // The test environment sets neither VITE_ALPHA_ORIGIN nor VITE_ALPHA_CLIENT_ID.
    expect(alphaConfig.ok).toBe(false)
    const { container, unmount } = render(
      <DatabaseProvider db={getDb()}>
        <AlphaSyncCard />
      </DatabaseProvider>,
    )
    expect(container.innerHTML).toBe('')
    unmount()
  })
})

describe('AlphaSyncCardView', () => {
  beforeEach(() => {
    useAlphaSyncStore.setState({ connection: null, engine: null, connectError: null })
  })
  afterEach(cleanup)

  it('offers Connect when this browser is not connected, and starts connecting to the configured server', async () => {
    useAlphaSyncStore.setState({ connection: { status: 'none' } })
    const actions = fakeActions()
    renderView(actions)
    expect(statusText()).toBeNull()
    expect(button('Disconnect')).toBeNull()
    await act(async () => {
      fireEvent.click(button('Connect AI Potluck') as HTMLElement)
    })
    expect(actions.connect).toHaveBeenCalledWith(config)
  })

  it('says why connecting failed, in the error’s own words, or as missing settings for an unknown failure', async () => {
    useAlphaSyncStore.setState({ connection: { status: 'none' } })
    const actions = fakeActions()
    actions.connect.mockImplementationOnce(async () => {
      throw new ConnectError('declined')
    })
    renderView(actions)
    await act(async () => {
      fireEvent.click(button('Connect AI Potluck') as HTMLElement)
    })
    expect(statusText()).toBe('The connection was declined on AI Potluck.')
    expect(screen.getByTestId('alpha-sync-status').className).toContain('text-destructive')

    actions.connect.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    await act(async () => {
      fireEvent.click(button('Connect AI Potluck') as HTMLElement)
    })
    expect(statusText()).toBe("AI Potluck's sign-in settings could not be found.")
  })

  it('waits for the first sync once connected, then says when it last synced', () => {
    useAlphaSyncStore.setState({ connection: { status: 'connected', origin: config.origin } })
    renderView(fakeActions())
    expect(statusText()).toBe('Connected to potluck.example. Waiting for the first sync…')
    expect(button('Retry')).toBeNull()

    act(() => {
      useAlphaSyncStore.setState({ engine: status({ lastOkAt: Date.now() - 60_000 }) })
    })
    expect(statusText()).toStartWith('Connected to potluck.example. Last synced ')
    expect(screen.getByTestId('alpha-sync-status').className).not.toContain('text-destructive')
  })

  it('reports a retrying loop with its reason and offers Retry', () => {
    useAlphaSyncStore.setState({
      connection: { status: 'connected', origin: config.origin },
      engine: status({ state: 'retrying', error: 'offline', lastOkAt: Date.now() }),
    })
    const actions = fakeActions()
    renderView(actions)
    expect(statusText()).toBe("Can't reach AI Potluck. Check your connection. Trying again shortly.")
    fireEvent.click(button('Retry') as HTMLElement)
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('reports a pull paused on the day’s budget as paused', () => {
    useAlphaSyncStore.setState({
      connection: { status: 'connected', origin: config.origin },
      engine: status({ state: 'paused', error: 'inbound-limit' }),
    })
    renderView(fakeActions())
    expect(statusText()).toBe(
      'AI Potluck sent more today than this device takes in a day. The rest arrives tomorrow. Sync is paused for now.',
    )
    expect(screen.getByTestId('alpha-sync-status').className).toContain('text-destructive')
  })

  it('talks about the push loop when it is in the worse state', () => {
    useAlphaSyncStore.setState({
      connection: { status: 'connected', origin: config.origin },
      engine: status({ state: 'ok', lastOkAt: Date.now() }, { state: 'paused', error: 'not-permitted' }),
    })
    renderView(fakeActions())
    expect(statusText()).toBe("This account isn't allowed to sync with AI Potluck. Sync is paused for now.")
    expect(worstLoop(status({ state: 'retrying' }, { state: 'idle' })).state).toBe('retrying')
  })

  it('counts rows that were not synced and offers Retry for them', () => {
    useAlphaSyncStore.setState({
      connection: { status: 'connected', origin: config.origin },
      engine: status({ lastOkAt: Date.now() }, {}, 3),
    })
    const actions = fakeActions()
    renderView(actions)
    expect(screen.getByTestId('alpha-sync-not-synced').textContent).toBe('3 items were not synced.')
    fireEvent.click(button('Retry') as HTMLElement)
    expect(actions.retry).toHaveBeenCalledTimes(1)
  })

  it('disconnects, clears a stale error and tells the app the connection changed', async () => {
    useAlphaSyncStore.setState({
      connection: { status: 'connected', origin: config.origin },
      connectError: 'declined',
    })
    const actions = fakeActions()
    renderView(actions)
    await act(async () => {
      fireEvent.click(button('Disconnect') as HTMLElement)
    })
    expect(actions.disconnect).toHaveBeenCalledWith(getDb(), config)
    expect(actions.announceConnectionChange).toHaveBeenCalledTimes(1)
    expect(useAlphaSyncStore.getState().connectError).toBeNull()
  })

  it('asks a signed-out device to reconnect, and offers Reconnect and Disconnect', async () => {
    useAlphaSyncStore.setState({ connection: { status: 'signed-out', origin: config.origin } })
    const actions = fakeActions()
    renderView(actions)
    expect(statusText()).toBe('AI Potluck signed this device out. Reconnect to keep syncing.')
    expect(button('Disconnect')).not.toBeNull()
    expect(button('Connect AI Potluck')).toBeNull()
    await act(async () => {
      fireEvent.click(button('Reconnect') as HTMLElement)
    })
    expect(actions.connect).toHaveBeenCalledWith(config)
  })
})
