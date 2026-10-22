/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** `offline_access` asks for a refresh token so the bridge survives the short access-token lifetime. */
export const alphaScope = 'conversations:sync offline_access'

/** The bridge's provider id; also the metadata key that carries AI Potluck's own fields on a message. */
export const alphaProviderId = 'alpha'

/** The callback route registered with AI Potluck for this client. */
export const alphaCallbackPath = '/oauth/alpha/callback'

/** Where this fork's source is published (MPL-2.0 §3.2), linked from the card. */
export const alphaSourceUrl = 'https://github.com/justinstimatze/thunderbolt/tree/ai-potluck-sync'

export type AlphaConfig = {
  /** The one AI Potluck deployment this build syncs with. */
  origin: string
  /** The OAuth client that deployment registered for this build (public client, PKCE, no secret). */
  clientId: string
}

export type AlphaConfigResult = { ok: true; config: AlphaConfig } | { ok: false; problem: 'missing' | 'invalid-origin' }

/**
 * Read the build's AI Potluck settings. There is no default server: a build that sets neither
 * variable hides the card and never makes a request. The Docker frontend build's arguments are empty
 * by default too; the public sandbox's image passes its own (see the README).
 * The origin must be https (or localhost in a development build) and is reduced to its origin, so a
 * path can't sneak in.
 */
export const parseAlphaConfig = (env: { origin?: string; clientId?: string }, isDev: boolean): AlphaConfigResult => {
  const origin = env.origin?.trim()
  const clientId = env.clientId?.trim()
  if (!origin || !clientId) {
    return { ok: false, problem: 'missing' }
  }
  try {
    const url = new URL(origin)
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    const allowed = url.protocol === 'https:' || (isDev && isLocal && url.protocol === 'http:')
    if (!allowed || url.username || url.password) {
      return { ok: false, problem: 'invalid-origin' }
    }
    return { ok: true, config: { origin: url.origin, clientId } }
  } catch {
    return { ok: false, problem: 'invalid-origin' }
  }
}

/** This build's configuration, from `VITE_ALPHA_ORIGIN` and `VITE_ALPHA_CLIENT_ID`. */
export const alphaConfig: AlphaConfigResult = parseAlphaConfig(
  { origin: import.meta.env.VITE_ALPHA_ORIGIN, clientId: import.meta.env.VITE_ALPHA_CLIENT_ID },
  import.meta.env.DEV,
)

if (!alphaConfig.ok && alphaConfig.problem === 'invalid-origin') {
  console.error('AI Potluck sync is off: VITE_ALPHA_ORIGIN must be an https origin.')
}
