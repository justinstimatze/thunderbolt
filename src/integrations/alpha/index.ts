/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * What the app shell imports. It stays small: the card, the callback page and the engine are
 * imported from their own modules where they are used, and the engine only loads once connected.
 */
export { useAlphaSync } from './use-alpha-sync'
export { alphaCallbackPath } from './config'
