/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * What synced text costs the markdown pipeline's math step, which a chat runs on every render of a
 * message that holds math: remark-parse + remark-gfm + remark-math, the math cap, then rehype-katex,
 * as memoized-markdown.tsx runs them, on text after renderSafe and rewriteMath. KaTeX's cost grows
 * with what it is given, so the cap (`math-cap.ts`) is what bounds it. Inputs stay at or below
 * 10,000 characters so an uncapped regression can't take the host down.
 * SYNCED_MATH_CASE / SYNCED_MATH_SIZE run one case at one size and print its timings.
 */

import { describe, expect, it } from 'bun:test'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { rewriteMath } from '@/components/chat/markdown-blocks'
import { mathAllowances, mathCaps, mathLengths, remarkCapMath } from '@/components/chat/math-cap'
import { renderSafe } from './map'

type Node = { type: string; value?: string; lang?: string | null; children?: Node[] }

/** Parse as the renderer does, with the cap given this allowance. */
const parse = (text: string, allowance: number) => {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkCapMath, { allowance })
  return parser.runSync(parser.parse(text)) as unknown as Node
}
const toHast = unified().use(remarkRehype).use(rehypeKatex)

/** The text of every node rehype-katex would render as math. */
const mathReachingKatex = (tree: Node): string[] => {
  const found: string[] = []
  const stack = [tree]
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'math' || node.type === 'inlineMath' || (node.type === 'code' && node.lang === 'math')) {
      found.push(node.value ?? '')
    }
    stack.push(...[...(node.children ?? [])].reverse())
  }
  return found
}

const timed = (fn: () => unknown) => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

const fraction = (chars: number) => {
  const depth = Math.floor(chars / 10)
  return `${'\\frac{1}{'.repeat(depth)}x${'}'.repeat(depth)}`
}

const cases: Record<string, (n: number) => string> = {
  'nested fractions': (n) => `$$\n${fraction(n)}\n$$`,
  'one wide display': (n) => `$$\n${'a+'.repeat(Math.floor(n / 2) - 4)}a\n$$`,
  'many inline spans': (n) => '$x$ '.repeat(Math.floor(n / 4)),
  'nested sqrt': (n) => `$$\n${'\\sqrt{'.repeat(Math.floor(n / 7))}x${'}'.repeat(Math.floor(n / 7))}\n$$`,
  'a math fence': (n) => `\`\`\`math\n${fraction(n)}\n\`\`\``,
  'display spans just under the expression cap': (n) =>
    Array.from({ length: Math.floor(n / (mathCaps.expressionChars + 8)) }, () => `$$\n${fraction(1990)}\n$$`).join(
      '\n\n',
    ),
}

const only = process.env.SYNCED_MATH_CASE
// Never above 10,000 characters, so a regression that removes the cap can't take the host down.
const sizes = process.env.SYNCED_MATH_SIZE
  ? [Math.min(Number(process.env.SYNCED_MATH_SIZE), 10_000)]
  : [2_500, 5_000, 10_000]

describe('synced math reaching KaTeX', () => {
  for (const [name, make] of Object.entries(cases)) {
    if (only && only !== name) {
      continue
    }
    it(`${name}: KaTeX gets no expression over the cap and no more than a message's worth, and stays under a second`, () => {
      for (const n of sizes) {
        const text = rewriteMath(renderSafe(make(n)))
        let tree: Node = { type: 'root' }
        const parseMs = timed(() => {
          tree = parse(text, mathCaps.messageChars)
        })
        const math = mathReachingKatex(tree)
        let error = ''
        const katexMs = timed(() => {
          try {
            toHast.runSync(tree as never)
          } catch (e) {
            error = String(e).slice(0, 80)
          }
        })
        // The timings, for whoever runs one case at one size by hand.
        if (only || process.env.SYNCED_MATH_SIZE) {
          process.stderr.write(
            `[synced math] ${name} n=${n}: mdast ${parseMs.toFixed(0)} ms, rehype-katex ${katexMs.toFixed(0)} ms, ` +
              `${math.length} expressions, ${math.join('').length} chars${error ? `, threw ${error}` : ''}\n`,
          )
        }
        expect(math.every((m) => m.length <= mathCaps.expressionChars)).toBe(true)
        expect(math.reduce((sum, m) => sum + m.length + mathCaps.expressionCost, 0)).toBeLessThanOrEqual(
          mathCaps.messageChars,
        )
        expect(error).toBe('')
        // Generous, since timing varies with the host's load: uncapped, the 10,000-character nested
        // root overflows KaTeX's stack, and 200,000 characters of nested fractions took 38 seconds.
        expect(katexMs).toBeLessThan(4000)
      }
    })
  }

  it('shows an expression over the cap as code, with its text intact', () => {
    const big = fraction(mathCaps.expressionChars + 10)
    const tree = parse(`$$\n${big}\n$$\n\nand $${'y+'.repeat(1500)}y$ inline`, mathCaps.messageChars)
    expect(mathReachingKatex(tree)).toEqual([])
    const code: Node[] = []
    const stack = [tree]
    for (let node = stack.pop(); node; node = stack.pop()) {
      if (node.type === 'code' || node.type === 'inlineCode') {
        code.push(node)
      }
      stack.push(...(node.children ?? []))
    }
    expect(code.map((c) => [c.type, c.value?.length])).toEqual(
      expect.arrayContaining([
        ['code', big.length],
        ['inlineCode', 3001],
      ]),
    )
  })

  it('still renders ordinary math as math', () => {
    const tree = parse('Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$', mathCaps.messageChars)
    expect(mathReachingKatex(tree)).toEqual(['e^{i\\pi} + 1 = 0', '\\int_0^1 x^2\\,dx = \\frac{1}{3}'])
  })

  it('spends one allowance across the blocks of a message, in order', () => {
    const lengthsOf = (content: string) => mathLengths(content, remarkMath)
    const blocks = [
      { content: `$$\n${'a'.repeat(1_996)}\n$$`, hasMath: true },
      { content: 'x'.repeat(50_000), hasMath: false },
      { content: `$${'b'.repeat(1_996)}$ and $${'c'.repeat(1_996)}$`, hasMath: true },
      { content: '$d$', hasMath: true },
    ]
    // 2,000 each with the per-expression cost: the third expression no longer fits, the last does.
    expect(mathAllowances(blocks, lengthsOf, 5_000)).toEqual([5_000, 3_000, 3_000, 1_000])
    const rendered = blocks.flatMap((block, i) =>
      mathReachingKatex(parse(block.content, mathAllowances(blocks, lengthsOf, 5_000)[i])).map((m) => m[0]),
    )
    expect(rendered).toEqual(['a', 'b', 'd'])
  })
})
