/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { RefreshCw } from 'lucide-react'
import { useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { useDatabase } from '@/contexts'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { useFormatters } from '@/i18n/use-formatters'
import { isTauri } from '@/lib/platform'
import { alphaConfig, alphaSourceUrl, type AlphaConfig } from './config'
import { ConnectError, disconnectAlpha, startAlphaConnect } from './connect'
import type { EngineStatus, LoopState, LoopStatus } from './engine'
import { connectErrorMessages, syncErrorMessages } from './error-messages'
import { useAlphaSyncStore } from './store'
import { announceAlphaConnectionChange, retryAlphaSync } from './use-alpha-sync'

const severity: Record<LoopState, number> = { ok: 0, idle: 1, retrying: 2, paused: 3, 'signed-out': 4 }

/** The loop the card should talk about: the one in the worse state. */
export const worstLoop = (status: EngineStatus): LoopStatus =>
  severity[status.push.state] > severity[status.pull.state] ? status.push : status.pull

/** What the card's buttons do. The app uses {@link defaultCardActions}; tests pass their own. */
export type AlphaSyncCardActions = {
  connect: (config: AlphaConfig) => Promise<void>
  disconnect: (db: AnyDrizzleDatabase, config: AlphaConfig) => Promise<void>
  retry: () => void
  announceConnectionChange: () => void
}

const defaultCardActions: AlphaSyncCardActions = {
  connect: (config) => startAlphaConnect(config),
  disconnect: (db, config) => disconnectAlpha(db, config),
  retry: retryAlphaSync,
  announceConnectionChange: announceAlphaConnectionChange,
}

/**
 * "AI Potluck" on Settings → Connections: connect this browser to the AI Potluck deployment this
 * build is configured for. While Thunderbolt is open, AI Potluck's chats are copied here, and chats
 * started after connecting are uploaded there, from every device on the account, not only this one.
 */
export const AlphaSyncCard = () => {
  // A build without an AI Potluck server shows nothing: there is nothing for its users to do.
  if (isTauri() || !alphaConfig.ok) {
    return null
  }
  return <AlphaSyncCardView config={alphaConfig.config} />
}

/** The card for a configured build, its state read from the shared AI Potluck store. */
export const AlphaSyncCardView = ({
  config,
  actions = defaultCardActions,
}: {
  config: AlphaConfig
  actions?: AlphaSyncCardActions
}) => {
  const { i18n, t } = useLingui()
  const db = useDatabase()
  const formatters = useFormatters()
  const { connection, engine, connectError, setConnectError } = useAlphaSyncStore()
  const [isPending, startTransition] = useTransition()

  const connect = () =>
    startTransition(async () => {
      setConnectError(null)
      try {
        await actions.connect(config)
      } catch (error) {
        setConnectError(error instanceof ConnectError ? error.code : 'no-metadata')
      }
    })

  const disconnect = () =>
    startTransition(async () => {
      await actions.disconnect(db, config)
      setConnectError(null)
      actions.announceConnectionChange()
    })

  const host = new URL(config.origin).host
  const loop = engine ? worstLoop(engine) : null
  const lastSynced = engine?.pull.lastOkAt ? formatters.relativeTime(new Date(engine.pull.lastOkAt)) : null
  const isTrouble = loop?.state === 'retrying' || loop?.state === 'paused'

  const status = (() => {
    if (connection?.status === 'signed-out') {
      return <Trans>AI Potluck signed this device out. Reconnect to keep syncing.</Trans>
    }
    if (connection?.status !== 'connected') {
      return connectError ? i18n._(connectErrorMessages[connectError]) : null
    }
    if (isTrouble && loop?.error) {
      return (
        <>
          {i18n._(syncErrorMessages[loop.error])}{' '}
          {loop.state === 'retrying' ? <Trans>Trying again shortly.</Trans> : <Trans>Sync is paused for now.</Trans>}
        </>
      )
    }
    if (lastSynced) {
      return (
        <Trans>
          Connected to {host}. Last synced {lastSynced}.
        </Trans>
      )
    }
    return <Trans>Connected to {host}. Waiting for the first sync…</Trans>
  })()

  const isConnected = connection?.status === 'connected'
  const notSynced = engine?.notSynced ?? 0

  return (
    <section
      aria-label={t`AI Potluck`}
      className="mt-5 flex flex-col gap-3 rounded-xl border border-border p-4"
      data-testid="alpha-sync-card"
    >
      <div className="flex items-center gap-2">
        <RefreshCw className="size-[var(--icon-size-sm)] text-muted-foreground" aria-hidden="true" />
        <h2 className="text-[length:var(--font-size-body)] font-medium">
          <Trans>AI Potluck</Trans>
        </h2>
        <a
          className="ml-auto text-[length:var(--font-size-sm)] text-primary underline-offset-4 hover:underline"
          href={alphaSourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          <Trans>Source</Trans>
        </a>
      </div>

      <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
        <Trans>
          While Thunderbolt is open in this browser, all your AI Potluck chats are copied here. Chats you start after
          connecting are uploaded to AI Potluck, including chats started on your other devices: connecting this browser
          is enough for all of them. Uploaded chats leave Thunderbolt's end-to-end encryption and are stored by AI
          Potluck. Private chats are never uploaded. Deleting a synced chat asks whether to delete it on AI Potluck too;
          deleting all chats at once deletes on AI Potluck only the ones started in Thunderbolt. Signing out of
          Thunderbolt disconnects; chats already on AI Potluck stay there.
        </Trans>
      </p>

      {status && (
        <p
          className={`text-[length:var(--font-size-sm)] ${isTrouble || connection?.status === 'signed-out' || (!isConnected && connectError) ? 'text-destructive' : ''}`}
          data-testid="alpha-sync-status"
        >
          {status}
        </p>
      )}

      {isConnected && notSynced > 0 && (
        <p className="text-[length:var(--font-size-sm)] text-muted-foreground" data-testid="alpha-sync-not-synced">
          <Plural value={notSynced} one="# item was not synced." other="# items were not synced." />
        </p>
      )}

      <div className="flex gap-2">
        {isConnected && (isTrouble || notSynced > 0) && (
          <Button size="sm" onClick={actions.retry} disabled={isPending}>
            <Trans>Retry</Trans>
          </Button>
        )}
        {connection?.status === 'signed-out' && (
          <Button size="sm" onClick={connect} disabled={isPending}>
            <Trans>Reconnect</Trans>
          </Button>
        )}
        {connection?.status === 'none' && (
          <Button size="sm" onClick={connect} disabled={isPending}>
            <Trans>Connect AI Potluck</Trans>
          </Button>
        )}
        {(isConnected || connection?.status === 'signed-out') && (
          <Button size="sm" variant="outline" onClick={disconnect} disabled={isPending}>
            <Trans>Disconnect</Trans>
          </Button>
        )}
      </div>
    </section>
  )
}
