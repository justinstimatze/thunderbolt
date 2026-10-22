/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { parseAlphaConfig } from './config'

describe('parseAlphaConfig', () => {
  it('has no default server: a build without both variables is not configured', () => {
    expect(parseAlphaConfig({}, false)).toEqual({ ok: false, problem: 'missing' })
    expect(parseAlphaConfig({ origin: 'https://develop.aipotluck.org' }, false)).toEqual({
      ok: false,
      problem: 'missing',
    })
    expect(parseAlphaConfig({ clientId: 'thunderbolt-sandbox' }, false)).toEqual({ ok: false, problem: 'missing' })
    expect(parseAlphaConfig({ origin: ' ', clientId: ' ' }, false)).toEqual({ ok: false, problem: 'missing' })
  })

  it('reduces the configured address to its origin', () => {
    expect(
      parseAlphaConfig({ origin: ' https://develop.aipotluck.org/chat ', clientId: 'thunderbolt-sandbox' }, false),
    ).toEqual({ ok: true, config: { origin: 'https://develop.aipotluck.org', clientId: 'thunderbolt-sandbox' } })
  })

  it('refuses a non-https origin, so tokens and conversations never travel in the clear', () => {
    for (const origin of ['http://www.aipotluck.org', 'ftp://x.example', 'not a url', 'https://user:pw@x.example']) {
      expect(parseAlphaConfig({ origin, clientId: 'c' }, false)).toEqual({ ok: false, problem: 'invalid-origin' })
    }
  })

  it('allows plain-http localhost only in a development build', () => {
    expect(parseAlphaConfig({ origin: 'http://localhost:5173', clientId: 'c' }, true)).toEqual({
      ok: true,
      config: { origin: 'http://localhost:5173', clientId: 'c' },
    })
    expect(parseAlphaConfig({ origin: 'http://localhost:5173', clientId: 'c' }, false)).toEqual({
      ok: false,
      problem: 'invalid-origin',
    })
  })
})
