/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ConnectErrorCode } from './connect'
import type { SyncErrorCode } from './errors'

/** What the card says about a sync failure. Descriptors at module scope, resolved with `i18n._` at render. */
export const syncErrorMessages: Record<SyncErrorCode, MessageDescriptor> = {
  offline: msg`Can't reach AI Potluck. Check your connection.`,
  timeout: msg`AI Potluck took too long to answer.`,
  'server-error': msg`AI Potluck had a problem on its side.`,
  'rate-limited': msg`AI Potluck asked to slow down.`,
  'stream-stalled': msg`The connection to AI Potluck went quiet.`,
  'stream-ended': msg`AI Potluck closed the connection.`,
  rejected: msg`AI Potluck refused a request from this app.`,
  'token-refused': msg`AI Potluck refused this device's access.`,
  'not-permitted': msg`This account isn't allowed to sync with AI Potluck.`,
  'sync-off': msg`Sync is turned off on AI Potluck.`,
  unreadable: msg`AI Potluck sent something this version can't read.`,
  'no-model': msg`Pick a model in Settings before chats can arrive from AI Potluck.`,
  'inbound-limit': msg`AI Potluck sent more today than this device takes in a day. The rest arrives tomorrow.`,
  'local-data': msg`This device's chats could not be loaded, so nothing was synced.`,
  'signed-out': msg`AI Potluck signed this device out. Reconnect to keep syncing.`,
  unknown: msg`Something went wrong while syncing.`,
}

/** What the card says when connecting fails. */
export const connectErrorMessages: Record<ConnectErrorCode, MessageDescriptor> = {
  'not-configured': msg`This build has no AI Potluck server configured.`,
  'no-metadata': msg`AI Potluck's sign-in settings could not be found.`,
  'foreign-endpoints': msg`AI Potluck's sign-in settings point at another site, so connecting stopped.`,
  declined: msg`The connection was declined on AI Potluck.`,
  'no-code': msg`AI Potluck did not return an authorization code.`,
  'not-started-here': msg`This connection was not started from this browser. Try connecting again.`,
  'exchange-failed': msg`AI Potluck did not accept the sign-in. Try connecting again.`,
  offline: msg`Can't reach AI Potluck. Check your connection.`,
}
