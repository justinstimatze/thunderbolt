/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Text synced from AI Potluck can be 200,000 characters of anything. These shapes target the
 * backtracking that renderSafe guards against in Thunderbolt's widget parser.
 */

import { describe, expect, it } from 'bun:test'
import { parseContentParts } from '@/ai/widget-parser'
import { renderSafe } from './map'

describe('hostile synced text through renderSafe and the widget parser', () => {
  const timed = (fn: () => unknown) => {
    const start = performance.now()
    fn()
    return performance.now() - start
  }
  const size = 200_000
  const fill = (unit: string) => unit.repeat(Math.floor(size / unit.length))
  const hostile: Record<string, string> = {
    'namespaced openers': fill('<a:b '),
    'widget openers': fill('<widget:x '),
    'unclosed titled citations': fill('【1†'),
    'titled citations with one close at the end': `${fill('【1†x')}】`,
    'spaces then citation openers': fill(`${' '.repeat(100)}【1`),
    'spaces then titled openers, closed at end': `${fill(`${' '.repeat(100)}【1†`)}】`,
    'one opener, long name run': `<${'a'.repeat(size - 1)}`,
    'colon opener, long name run': `<a:${'a'.repeat(size - 3)}`,
    'image openers': fill('!['),
    'citation-split tags': fill('<【1】widget:x '),
    'alternating whitespace kinds': fill(' \t\u00a0\u2028\u3000'),
  }

  for (const [name, text] of Object.entries(hostile)) {
    it(`renderSafe then parseContentParts on ${name} (${text.length} chars) renders no widget and stays linear`, () => {
      let safe = ''
      const renderMs = timed(() => {
        safe = renderSafe(text)
      })
      const parseMs = timed(() => parseContentParts(safe))
      expect(parseContentParts(safe).some((p) => p.type === 'widget')).toBe(false)
      // Both passes are linear: the worst shape here took about 350 ms at 200,000 characters on a
      // loaded host, and doubled with each doubling of size. A quadratic pass takes minutes.
      expect(renderMs + parseMs).toBeLessThan(2000)
    })
  }
})
