/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getDb } from '@/db/database'
import { postToAlphaChannel } from './channel'
import { alphaConfig } from './config'
import { disconnectAlpha } from './connect'
import { useAlphaSyncStore } from './store'

/**
 * Disconnect AI Potluck before local data is wiped (sign-out, device revocation, account deletion),
 * so the grant is revoked rather than left valid on a device nobody is signed in to. Never throws:
 * clearing local data must not depend on AI Potluck being reachable.
 */
export const teardownAlphaSync = async (): Promise<void> => {
  try {
    await disconnectAlpha(getDb(), alphaConfig.ok ? alphaConfig.config : null)
    // This tab's own bridge stops too: the channel reaches only the other tabs.
    useAlphaSyncStore.getState().bumpConnection()
    postToAlphaChannel({ type: 'connection-changed' })
  } catch (error) {
    console.warn('AI Potluck disconnect during sign-out failed', error)
  }
}
