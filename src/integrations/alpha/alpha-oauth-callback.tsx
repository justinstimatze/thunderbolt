/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useDatabase } from '@/contexts'
import Loading from '@/loading'
import { alphaConfig } from './config'
import { completeAlphaConnect, ConnectError, type ConnectErrorCode } from './connect'
import { useAlphaSyncStore } from './store'
import { announceAlphaConnectionChange } from './use-alpha-sync'

/** Where AI Potluck's consent screen sends the person back to. */
const connectionsPath = '/settings/connections'

/** Read the callback URL. Only the OAuth error code counts: anyone can craft this URL, so its free text never reaches the card. */
const readCallback = (search: string): { code: string; state: string; iss: string | null } | ConnectErrorCode => {
  const params = new URLSearchParams(search)
  const error = params.get('error')
  const code = params.get('code')
  const state = params.get('state')
  if (error === 'access_denied') {
    return 'declined'
  }
  if (error || !code || !state) {
    return 'no-code'
  }
  return { code, state, iss: params.get('iss') }
}

/**
 * `/oauth/alpha/callback`: finishes the code exchange after AI Potluck's consent page redirects
 * back, then returns to Settings → Connections, where the card shows the result.
 */
const AlphaOAuthCallback = () => {
  const db = useDatabase()
  const navigate = useNavigate()
  // The code is single-use: a second exchange (React's StrictMode runs effects twice) would fail
  // and overwrite the first one's result with an error.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) {
      return
    }
    started.current = true
    const { setConnectError } = useAlphaSyncStore.getState()
    const complete = async () => {
      const callback = readCallback(window.location.search)
      try {
        if (!alphaConfig.ok) {
          throw new ConnectError('not-configured')
        }
        if (typeof callback === 'string') {
          throw new ConnectError(callback)
        }
        await completeAlphaConnect(db, alphaConfig.config, callback)
        setConnectError(null)
      } catch (error) {
        setConnectError(error instanceof ConnectError ? error.code : 'exchange-failed')
      } finally {
        announceAlphaConnectionChange()
        navigate(connectionsPath, { replace: true })
      }
    }
    void complete()
  }, [db, navigate])

  return (
    <div className="flex flex-1 flex-col items-center justify-center min-h-screen bg-background">
      <Loading />
    </div>
  )
}

export default AlphaOAuthCallback
