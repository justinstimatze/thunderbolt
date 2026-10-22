/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * The math caps count source characters, but KaTeX expands macros: three nested `\def`s in 632
 * characters render as 40 MB of HTML under KaTeX's defaults. These tests hold the pipeline to what
 * a short expression may cost once expanded.
 */

import { describe, expect, it } from 'bun:test'
import katex from 'katex'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { renderSafe } from '@/integrations/alpha/map'
import { definesMacro, katexOptions, mathAllowances, mathCaps, mathLengths, remarkCapMath } from './math-cap'

type Node = { type: string; value?: string; children?: Node[] }

/** Three nested macros: `\n` expands to 10 `\m`, each to 10 `\l`, each to `leafReps` fractions. */
const expansionBomb = (leafReps: number, fanout: number, tops: number) => {
  const leaf = '\\frac{x}{y}'.repeat(leafReps)
  return `\\def\\l{${leaf}}\\def\\m{${'\\l'.repeat(fanout)}}\\def\\n{${'\\m'.repeat(fanout)}}${'\\n'.repeat(tops)}`
}

/** 632 characters that render as about 40 MB of HTML with KaTeX's default options. */
const bomb = expansionBomb(50, 10, 9)

/** The renderer's pipeline on one message: the math cap, then rehype-katex with its options. */
const renderToHast = (text: string) => {
  const parser = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkCapMath, { allowance: mathCaps.messageChars })
  const mdast = parser.runSync(parser.parse(text))
  return unified()
    .use(remarkRehype)
    .use(rehypeKatex, katexOptions)
    .runSync(mdast as never) as unknown as Node
}

const topLevelTypes = (text: string) => {
  const parser = unified().use(remarkParse).use(remarkMath).use(remarkCapMath, { allowance: mathCaps.messageChars })
  return ((parser.runSync(parser.parse(text)) as unknown as Node).children ?? []).map((n) => n.type)
}

describe('math that defines a macro', () => {
  it('renders a 632-character macro expansion bomb as code, so the rendered message stays small', () => {
    expect(bomb.length).toBe(632)
    const synced = renderSafe(`$$\n${bomb}\n$$`)
    expect(topLevelTypes(synced)).toEqual(['code'])
    const rendered = JSON.stringify(renderToHast(synced))
    expect(rendered.length).toBeLessThan(10_000)
    expect(rendered).not.toContain('katex')
  })

  it('treats every macro-defining command as a definition, and no ordinary command that starts the same', () => {
    const definers = [
      '\\def\\a{x}',
      '\\gdef\\a{x}',
      '\\edef\\a{x}',
      '\\xdef\\a{x}',
      '\\let\\a=x',
      '\\futurelet\\a\\b\\c',
      '\\global\\def\\a{x}',
      '\\long\\def\\a#1{#1}',
      '\\newcommand{\\a}{x}',
      '\\renewcommand{\\a}{x}',
      '\\providecommand{\\a}{x}',
      'x \\def ',
    ]
    expect(definers.filter((e) => !definesMacro(e))).toEqual([])
    const ordinary = [
      '\\left( x \\right)',
      '\\longrightarrow',
      '\\leftarrow',
      '\\delta',
      '\\defeq',
      '\\lettrine',
      '\\le',
    ]
    expect(ordinary.filter(definesMacro)).toEqual([])
  })

  it('costs the message nothing, so math after it in the same message still renders', () => {
    // 1,500 characters: under the expression cap, so only the definition keeps it from rendering.
    const defining = `$${'\\def\\a{x}'.repeat(150)}$`
    const text = `${defining} and then $e^{i\\pi} + 1 = 0$`
    const lengths = mathLengths(text, remarkMath)
    expect(lengths).toEqual([Infinity, 16])
    const blocks = [defining, '$e^{i\\pi} + 1 = 0$'].map((content) => ({ content, hasMath: true }))
    expect(mathAllowances(blocks, (content) => mathLengths(content, remarkMath))).toEqual([
      mathCaps.messageChars,
      mathCaps.messageChars,
    ])
    const rendered = JSON.stringify(renderToHast(text))
    expect(rendered).toContain('katex')
    expect(rendered).toContain('\\\\def\\\\a{x}')
  })
})

describe('KaTeX options', () => {
  it('bounds expansion: the same bomb handed to KaTeX directly is a short error, not 40 MB', () => {
    const html = katex.renderToString(bomb, { ...katexOptions, throwOnError: false, displayMode: true })
    expect(html).toContain('katex-error')
    expect(html.length).toBeLessThan(10_000)
  })

  it('caps a user-given size at maxSize ems', () => {
    const html = katex.renderToString('\\rule{1000000em}{1000000em}', { ...katexOptions, throwOnError: false })
    // The source stays in the MathML annotation; every size KaTeX lays out is capped.
    expect(html).toContain(`border-right-width:${katexOptions.maxSize}em;border-top-width:${katexOptions.maxSize}em`)
    expect(html).not.toContain('1000000em;')
  })

  it('still renders ordinary math that uses built-in macros', () => {
    const matrix =
      'A=\\begin{pmatrix} a_{11} & \\cdots & a_{1n} \\\\ \\vdots & \\ddots & \\vdots \\\\ a_{m1} & \\cdots & a_{mn} \\end{pmatrix}'
    const inequality =
      '\\forall x \\neq y,\\ \\|f(x)-f(y)\\| \\leq L\\|x-y\\| \\iff \\dots \\implies x_1,\\ldots,x_n \\geq 0'
    for (const expression of [matrix, inequality]) {
      const html = katex.renderToString(expression, { ...katexOptions, throwOnError: false })
      expect(html).not.toContain('katex-error')
    }
  })
})
