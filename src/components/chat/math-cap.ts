/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified, type Pluggable } from 'unified'

/** The mdast fields this pass reads; remark-math adds `math` and `inlineMath` nodes. */
type MdastNode = {
  type: string
  value?: string
  lang?: string | null
  children?: MdastNode[]
  position?: unknown
}

/**
 * How much math one message may hand KaTeX. Rendering costs roughly a fixed amount per expression
 * plus an amount per character (a 2,000-character expression takes tens to hundreds of
 * milliseconds; 200,000 characters of math took tens of seconds and gigabytes in testing), and a
 * message renders again every time its chat opens. Text synced from another service can be 200,000
 * characters of anything, so past these caps math is shown as code instead.
 */
export const mathCaps = {
  /** Longest single expression rendered as math. */
  expressionChars: 2_000,
  /** What one message may spend: each expression costs its length plus `expressionCost`. */
  messageChars: 5_000,
  /** The fixed cost of one expression, in characters' worth of rendering time. */
  expressionCost: 4,
}

/**
 * Options for rehype-katex. The caps above count source characters, but KaTeX expands macros, so
 * each expansion can emit far more than it reads: `maxExpand` bounds how many expansions one
 * expression may make (KaTeX's default is 1,000), and `maxSize` caps every user-given size, such as
 * `\rule{1e6em}{1e6em}`, in ems (KaTeX's default is unbounded). A 1,575-character expression with
 * 25 `\neq` and `\leq` needs 100 expansions, and 30 runs of `\dots`, `\cdots` and `\neq` in 1,200
 * characters need 240; an expression past the limit renders as a KaTeX error showing its source.
 */
export const katexOptions = { maxExpand: 200, maxSize: 20 } as const

/**
 * Commands that define a macro, as KaTeX reads a control word (`\` and a run of letters or `@`).
 * One definition can expand into many times its own length, so an expression that defines a macro
 * is shown as code, whatever its length.
 */
const macroDefinition =
  /\\(?:def|gdef|edef|xdef|let|futurelet|global|long|newcommand|renewcommand|providecommand)(?![a-zA-Z@])/

/** Whether a math expression defines a macro (see {@link macroDefinition}). */
export const definesMacro = (expression: string): boolean => macroDefinition.test(expression)

/** What an expression costs the caps: an expression that defines a macro never renders. */
const mathCost = (node: MdastNode): number => {
  const value = node.value ?? ''
  return definesMacro(value) ? Infinity : value.length
}

/** A math node rehype-katex would render: `$$…$$`, `$…$`, or a ```math fence. */
const isMath = (node: MdastNode): boolean =>
  node.type === 'math' || node.type === 'inlineMath' || (node.type === 'code' && node.lang === 'math')

/** The same text as code, which no later pass renders as math. */
const asCode = (node: MdastNode): MdastNode =>
  node.type === 'inlineMath'
    ? { type: 'inlineCode', value: node.value ?? '', position: node.position }
    : { type: 'code', lang: null, value: node.value ?? '', position: node.position }

/**
 * Visit every math node in document order. Walks with its own stack, so deep nesting can't overflow
 * it. `visit` may return a node to put in the math node's place.
 */
const eachMath = (tree: MdastNode, visit: (node: MdastNode) => MdastNode | void) => {
  const stack: { siblings: MdastNode[]; index: number }[] = []
  // Children go on the stack last first, so they come off in document order.
  const pushChildren = (node: MdastNode) => {
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      stack.push({ siblings: node.children as MdastNode[], index })
    }
  }
  pushChildren(tree)
  for (let next = stack.pop(); next; next = stack.pop()) {
    const node = next.siblings[next.index]
    if (!isMath(node)) {
      pushChildren(node)
      continue
    }
    const replacement = visit(node)
    if (replacement) {
      next.siblings[next.index] = replacement
    }
  }
}

/**
 * Spend `allowance` on expressions of these lengths, in order: one renders when it is no longer than
 * `expressionChars` and its cost fits in what is left. Returns which render and what they spent.
 */
const spend = (lengths: readonly number[], allowance: number) => {
  let left = allowance
  const renders = lengths.map((length) => {
    const cost = length + mathCaps.expressionCost
    if (length > mathCaps.expressionChars || cost > left) {
      return false
    }
    left -= cost
    return true
  })
  return { renders, spent: allowance - left }
}

/**
 * A remark plugin, run after remark-math: math past `allowance` (what the message has left after its
 * earlier blocks, see {@link mathAllowances}), longer than `expressionChars`, or that defines a macro
 * becomes code.
 */
export const remarkCapMath =
  ({ allowance }: { allowance: number }) =>
  (tree: MdastNode): void => {
    const lengths: number[] = []
    eachMath(tree, (node) => {
      lengths.push(mathCost(node))
    })
    const { renders } = spend(lengths, allowance)
    let index = 0
    eachMath(tree, (node) => (renders[index++] ? undefined : asCode(node)))
  }

/** Lengths of the math expressions in a block, by its content; one message's blocks stay cached while it streams. */
const lengthsCache = new Map<string, number[]>()
const lengthsCacheSize = 200

/**
 * The lengths of the math expressions in `content`, as the renderer parses it with `remarkMath`; one
 * that defines a macro counts as longer than any cap.
 */
export const mathLengths = (content: string, remarkMath: Pluggable): number[] => {
  const cached = lengthsCache.get(content)
  if (cached) {
    return cached
  }
  const parser = unified().use(remarkParse).use(remarkGfm).use([remarkMath])
  const lengths: number[] = []
  eachMath(parser.runSync(parser.parse(content)) as unknown as MdastNode, (node) => {
    lengths.push(mathCost(node))
  })
  if (lengthsCache.size >= lengthsCacheSize) {
    lengthsCache.delete(lengthsCache.keys().next().value as string)
  }
  lengthsCache.set(content, lengths)
  return lengths
}

/**
 * The math allowance of each block of one message, in order: what the message has left after the
 * blocks before it rendered theirs. Each block renders separately, so this is what keeps the whole
 * message within `messageChars`.
 */
export const mathAllowances = (
  blocks: readonly { content: string; hasMath: boolean }[],
  lengthsOf: (content: string) => number[],
  messageChars = mathCaps.messageChars,
): number[] => {
  let left = messageChars
  return blocks.map(({ content, hasMath }) => {
    const allowance = left
    if (hasMath) {
      left -= spend(lengthsOf(content), allowance).spent
    }
    return allowance
  })
}
