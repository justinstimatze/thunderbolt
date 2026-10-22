/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { rewriteMath } from './markdown-blocks'

/*
 * Differential check for an upstream maintainer: the fork replaced the math regexes in an upstream
 * rendering path with hand-written scanners. The upstream (a56ac30b) implementation is copied here
 * verbatim, and the two are compared on many small seeded random inputs over the characters the
 * passes care about. Any difference is a behaviour change to upstream rendering.
 */
const displayMathDelimiters = /(^[ \t]*)?\\\[([\s\S]+?)\\\]/gm
const inlineMathDelimiters = /\\\(([\s\S]+?)\\\)/g
const displayMathLine = /^([ \t]*)\$\$[ \t]*(.+?)[ \t]*\$\$[ \t]*$/gm
const indentedFence = (indent: string, body: string): string => {
  const inner = body
    .trim()
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n')
  return `${indent}$$\n${inner}\n${indent}$$`
}
const displayMathSpan = /\$\$[\s\S]*?\$\$/g
const inlineMathSpan = /\$(?![\s$])[^$\n]*?(?<!\s)\$(?!\d)/g
const escapeCurrencyDollars = (text: string): string => {
  const spans: Array<[number, number]> = []
  for (const regex of [displayMathSpan, inlineMathSpan]) {
    for (const match of text.matchAll(regex)) {
      spans.push([match.index, match.index + match[0].length])
    }
  }
  const insideMath = (index: number): boolean => spans.some(([start, end]) => index >= start && index < end)
  return text.replace(/\$(?=\d)/g, (dollar, index: number) => (insideMath(index) ? dollar : '\\$'))
}
const upstreamRewriteMath = (text: string): string =>
  escapeCurrencyDollars(
    text
      .replace(displayMathDelimiters, (match, indent: string | undefined, body: string) =>
        body.trim() ? indentedFence(indent ?? '', body) : match,
      )
      .replace(inlineMathDelimiters, (match, body: string) => {
        const inner = body.trim().replace(/\s+/g, ' ')
        return inner ? `$${inner}$` : match
      })
      .replace(displayMathLine, (_match, indent: string, body: string) => indentedFence(indent, body)),
  )

/** mulberry32: a small seeded PRNG, so a failure reproduces. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('rewriteMath matches upstream behaviour', () => {
  it('gives the same output as the upstream regex version on 50,000 random short inputs', () => {
    const alphabet = ['\\', '\\[', '\\]', '\\(', '\\)', '$', '$$', ' ', '\t', '\n', '\r', 'a', '1', '[', ')']
    const random = seeded(14)
    const diffs: { input: string; upstream: string; fork: string }[] = []
    for (let i = 0; i < 50_000; i++) {
      const length = 1 + Math.floor(random() * 14)
      let input = ''
      for (let j = 0; j < length; j++) {
        input += alphabet[Math.floor(random() * alphabet.length)]
      }
      const upstream = upstreamRewriteMath(input)
      const fork = rewriteMath(input)
      if (upstream !== fork && diffs.length < 5) {
        diffs.push({ input, upstream, fork })
      }
    }
    expect(diffs).toEqual([])
  })
})
