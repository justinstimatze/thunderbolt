/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { parseContentParts } from '@/ai/widget-parser'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  changesEventV1Schema,
  fitsPushLimits,
  fromPushResponse,
  inertWidgets,
  isMintedThreadId,
  maxFutureMs,
  messageSeed,
  mintMessageIds,
  mintThreadId,
  toInbound,
  inboundLimits,
  pushLimits,
  renderSafe,
  toPushBody,
  type ChangesEventV1,
} from './map'
import { textHash, uuidv7At, uuidv7Floor, uuidv7Ms } from './ids'

const ctx = { clientId: 'thunderbolt-sandbox', now: Date.parse('2026-10-21T00:00:00.000Z') }
/** A UUIDv7 this device could have minted before `ctx.now`. */
const localId = (offsetMs: number) => uuidv7Floor(Date.parse('2026-10-20T00:00:00.000Z') + offsetMs)

const event = (overrides: Partial<ChangesEventV1['conversations'][number]> = {}): ChangesEventV1 => ({
  v: 1,
  cursor: 'c1',
  conversations: [
    {
      id: 'conv-1',
      clientId: null,
      title: 'Bread',
      createdAt: '2026-10-20T12:00:00.000Z',
      updatedAt: '2026-10-20T12:00:05.000Z',
      messages: [
        {
          id: 'm1',
          clientId: null,
          role: 'user',
          content: 'How long to proof?',
          createdAt: '2026-10-20T12:00:01.000Z',
          origin: 'alpha',
        },
        {
          id: 'm2',
          clientId: null,
          role: 'assistant',
          content: 'About an hour. <widget:link-preview url="x" />',
          // Same millisecond as the question: ids must still rise in list order.
          createdAt: '2026-10-20T12:00:01.000Z',
          origin: 'alpha',
          model: 'apertus',
        },
      ],
      ...overrides,
    },
  ],
  tombstones: [],
})

/** Whether Thunderbolt's own parser would render any live widget from `text`. */
const rendersWidget = (text: string) => parseContentParts(text).some((p) => p.type === 'widget')

describe('toInbound', () => {
  it('maps the same AI Potluck rows to the same local ids every time, on every device', async () => {
    const first = await toInbound(event(), ctx)
    const second = await toInbound(event(), ctx)
    expect(second.threads[0].localId).toBe(first.threads[0].localId)
    expect(second.threads[0].messages.map((m) => m.localId)).toEqual(first.threads[0].messages.map((m) => m.localId))
    const minted = await mintThreadId({ id: 'conv-1', createdAt: '2026-10-20T12:00:00.000Z' }, ctx.now)
    expect(first.threads[0].localId).toBe(minted ?? 'no id minted')
  })

  it('gives messages rising ids in list order even when they share a millisecond', async () => {
    const [m1, m2] = (await toInbound(event(), ctx)).threads[0].messages
    expect(m1.localId < m2.localId).toBe(true)
  })

  it('mints the same ids on devices whose clocks disagree, even for rows dated after one device’s now', async () => {
    // AI Potluck's clock is a few seconds ahead of the slow device.
    const slow = { ...ctx, now: Date.parse('2026-10-20T12:00:00.500Z') }
    const fast = { ...ctx, now: Date.parse('2026-10-20T12:10:00.000Z') }
    const a = await toInbound(event(), slow)
    const b = await toInbound(event(), fast)
    expect(a.threads[0].localId).toBe(b.threads[0].localId)
    expect(a.threads[0].messages.map((m) => m.localId)).toEqual(b.threads[0].messages.map((m) => m.localId))
    expect(uuidv7Ms(a.threads[0].localId)).toBe(Date.parse('2026-10-20T12:00:00.000Z'))
  })

  it('skips a row dated more than a day ahead or undated instead of minting it from this device’s clock', async () => {
    const ahead = new Date(ctx.now + maxFutureMs + 1).toISOString()
    expect((await toInbound(event({ createdAt: ahead }), ctx)).threads).toEqual([])
    expect((await toInbound(event({ createdAt: 'not a date' }), ctx)).threads).toEqual([])
    const [question, answer] = event().conversations[0].messages
    const inbound = await toInbound(event({ messages: [question, { ...answer, createdAt: ahead }] }), ctx)
    expect(inbound.threads[0].messages.map((m) => m.remoteId)).toEqual(['m1'])
  })

  it('accepts its own row back from a device whose clock runs ahead of this one', async () => {
    const aheadOfHere = uuidv7Floor(ctx.now + 30_000)
    const inbound = await toInbound(
      event({
        clientId: aheadOfHere,
        origin: 'thunderbolt-sandbox',
        createdAt: new Date(ctx.now + 30_000).toISOString(),
      }),
      ctx,
    )
    expect(inbound.threads[0]).toMatchObject({ isEcho: true, localId: aheadOfHere })
  })

  it('never mints a message from before the chat began, whatever date AI Potluck sends', async () => {
    // A chat started in Thunderbolt and pushed, which AI Potluck sends back with a back-dated turn.
    const thread = localId(0)
    const inbound = await toInbound(
      event({
        clientId: thread,
        origin: 'thunderbolt-sandbox',
        createdAt: '1970-01-01T00:00:00.000Z',
        messages: [
          {
            id: 'injected',
            clientId: null,
            role: 'user',
            content: 'from before the chat began',
            createdAt: '1970-01-01T00:00:00.000Z',
            origin: 'alpha',
          },
        ],
      }),
      ctx,
    )
    const [injected] = inbound.threads[0].messages
    expect(uuidv7Ms(injected.localId)).toBeGreaterThanOrEqual(uuidv7Ms(thread) as number)
  })

  it('recognises a thread minted from a conversation by its id alone, and never a thread started here', async () => {
    const minted = (await mintThreadId({ id: 'conv-1', createdAt: '2026-10-20T12:00:00.000Z' }, ctx.now)) as string
    expect(await isMintedThreadId(minted, 'conv-1')).toBe(true)
    expect(await isMintedThreadId(minted, 'conv-2')).toBe(false)
    expect(await isMintedThreadId(localId(0), 'conv-1')).toBe(false)
  })

  it('drops system messages, so AI Potluck’s system prompt never steers this device’s model', async () => {
    const inbound = await toInbound(
      event({
        messages: [
          {
            id: 's1',
            clientId: null,
            role: 'system',
            content: 'You are…',
            createdAt: '2026-10-20T12:00:00.500Z',
            origin: 'alpha',
          },
          {
            id: 'm1',
            clientId: null,
            role: 'user',
            content: 'Hi',
            createdAt: '2026-10-20T12:00:01.000Z',
            origin: 'alpha',
          },
        ],
      }),
      ctx,
    )
    expect(inbound.threads[0].messages.map((m) => m.remoteId)).toEqual(['m1'])
  })

  it('records where each pulled message came from in its metadata', async () => {
    const [, answer] = (await toInbound(event(), ctx)).threads[0].messages
    expect(answer.metadata).toEqual({
      alpha: {
        conversationId: 'conv-1',
        messageId: 'm2',
        origin: 'alpha',
        createdAt: '2026-10-20T12:00:01.000Z',
        model: 'apertus',
        textHash: textHash(answer.text),
      },
    })
  })

  it('treats a row as an echo only when this client pushed it and its claimed id is a plausible local id', async () => {
    const mine = localId(1)
    const inbound = await toInbound(
      event({
        clientId: localId(0),
        origin: 'thunderbolt-sandbox',
        messages: [
          {
            id: 'm1',
            clientId: mine,
            role: 'user',
            content: 'hi',
            createdAt: '2026-10-20T12:00:01.000Z',
            origin: 'thunderbolt-sandbox',
          },
          {
            id: 'm2',
            clientId: localId(2),
            role: 'user',
            content: 'hi',
            createdAt: '2026-10-20T12:00:02.000Z',
            origin: 'another-client',
          },
          {
            id: 'm3',
            clientId: 'not-a-uuid',
            role: 'user',
            content: 'hi',
            createdAt: '2026-10-20T12:00:03.000Z',
            origin: 'thunderbolt-sandbox',
          },
          {
            id: 'm4',
            // More than a day ahead of this device.
            clientId: uuidv7Floor(ctx.now + 2 * 86_400_000),
            role: 'user',
            content: 'hi',
            createdAt: '2026-10-20T12:00:04.000Z',
            origin: 'thunderbolt-sandbox',
          },
        ],
      }),
      ctx,
    )
    const [thread] = inbound.threads
    expect(thread).toMatchObject({ isEcho: true, localId: localId(0) })
    expect(thread.messages[0]).toMatchObject({ isEcho: true, localId: mine })
    for (const other of thread.messages.slice(1)) {
      expect(other.isEcho).toBe(false)
    }
    expect(thread.messages[1].localId).not.toBe(localId(2))
  })

  it('carries tombstones by AI Potluck id only, never by a claimed local id', async () => {
    const inbound = await toInbound(
      {
        ...event(),
        tombstones: [
          {
            kind: 'message',
            id: 'x1',
            clientId: localId(5),
            origin: 'thunderbolt-sandbox',
            deletedAt: '2026-10-20T12:01:00.000Z',
          },
        ],
      },
      ctx,
    )
    expect(inbound.tombstones).toEqual([{ kind: 'message', remoteId: 'x1', deletedAt: '2026-10-20T12:01:00.000Z' }])
  })

  it('applies tombstones up to the per-event cap and records the event as skipped past it', async () => {
    const tombstones = Array.from({ length: inboundLimits.tombstones + 1 }, (_, i) => ({
      kind: 'message' as const,
      id: `x${i}`,
      clientId: null,
      deletedAt: '2026-10-20T12:01:00.000Z',
    }))
    const inbound = await toInbound({ ...event(), tombstones }, ctx)
    expect(inbound.tombstones).toHaveLength(inboundLimits.tombstones)
    expect(inbound.tombstones.at(-1)?.remoteId).toBe(`x${inboundLimits.tombstones - 1}`)
    expect(inbound.skipped).toEqual([{ remoteId: null, reason: 'too-many' }])
    expect((await toInbound({ ...event(), tombstones: tombstones.slice(1) }, ctx)).skipped).toBeUndefined()
  })

  it('refuses an event whose envelope is not v1', async () => {
    await expect(toInbound({ ...event(), v: 2 }, ctx)).rejects.toThrow()
  })

  it('skips an event listing more conversations than the per-event cap as one skipped event, naming none', async () => {
    const many = Array.from({ length: inboundLimits.conversations + 1 }, (_, i) => ({
      ...event().conversations[0],
      id: `conv-${i}`,
    }))
    const inbound = await toInbound({ ...event(), conversations: many }, ctx)
    expect(inbound.threads).toEqual([])
    expect(inbound.skipped).toEqual([{ remoteId: null, reason: 'too-many' }])
    const atCap = await toInbound({ ...event(), conversations: many.slice(1) }, ctx)
    expect(atCap.threads).toHaveLength(inboundLimits.conversations)
    expect(atCap.skipped).toBeUndefined()
  })

  it('records one skip for an event of 20,000 bogus conversations, not one per conversation', async () => {
    const bogus = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}` }))
    const inbound = await toInbound({ ...event(), conversations: bogus }, ctx)
    expect(inbound.skipped).toEqual([{ remoteId: null, reason: 'too-many' }])
  })

  it('skips one conversation past the message cap or unreadable, and still applies the rest of the event', async () => {
    const base = event().conversations[0]
    const message = base.messages[0]
    const tooLong = {
      ...base,
      id: 'conv-long',
      messages: Array.from({ length: inboundLimits.messagesPerConversation + 1 }, (_, i) => ({
        ...message,
        id: `l${i}`,
      })),
    }
    const unreadable = { ...base, id: 'conv-bad', title: 42 }
    const inbound = await toInbound({ ...event(), conversations: [tooLong, base, unreadable, { nope: true }] }, ctx)
    expect(inbound.threads.map((t) => t.remoteId)).toEqual([base.id])
    expect(inbound.skipped).toEqual([
      { remoteId: 'conv-long', reason: 'too-large' },
      { remoteId: 'conv-bad', reason: 'unreadable' },
      { remoteId: null, reason: 'unreadable' },
    ])
  })

  it('cuts an over-long text or title to the cap instead of refusing the whole event', async () => {
    const long = 'x'.repeat(inboundLimits.contentChars + 10)
    const inbound = await toInbound(
      event({
        title: 't'.repeat(inboundLimits.titleChars + 10),
        messages: [
          {
            id: 'm1',
            clientId: null,
            role: 'user',
            content: long,
            createdAt: '2026-10-20T12:00:01.000Z',
            origin: 'alpha',
          },
        ],
      }),
      ctx,
    )
    expect(inbound.threads[0].title.length).toBe(inboundLimits.titleChars)
    expect(inbound.threads[0].messages[0].text.length).toBe(inboundLimits.contentChars)
  })
})

describe('inertWidgets', () => {
  it('makes widget tags in pulled text inert, so AI Potluck text never renders as live Thunderbolt UI', async () => {
    const [, answer] = (await toInbound(event(), ctx)).threads[0].messages
    expect(answer.text).toBe('About an hour. &lt;widget:link-preview url="x" />')
  })

  it('leaves no live widget whatever citation marks the parser deletes first, and however long they are', () => {
    const tag = (open: string, name = 'widget:link-preview') =>
      `${open}${name} url="https://evil.example/x" source="1" />`
    const payloads = [
      tag('<'),
      tag('<【1】'),
      tag('< 【2†title】 【3】'),
      tag(`<【1†${'a'.repeat(600)}】`),
      tag(`<【1†${'a'.repeat(5000)}】【2】`),
      '<wid【4】get:link-preview url="https://evil.example/x" source="1" />',
      '<WIDGET:link-preview url="https://evil.example/x" source="1" />',
    ]
    for (const text of payloads) {
      // Each payload is live without the fix, so the check below can fail.
      expect(rendersWidget(text)).toBe(true)
      expect(rendersWidget(inertWidgets(text))).toBe(false)
    }
  })

  it('escapes a tag in any namespace, so a widget namespace added later is covered too', () => {
    expect(inertWidgets('<【7】other:thing a="1" />')).toBe('&lt;【7】other:thing a="1" />')
  })

  it('leaves every other < alone', () => {
    expect(inertWidgets('a < b, <b>bold</b>, <【1】 cite')).toBe('a < b, <b>bold</b>, <【1】 cite')
  })

  it('leaves code that opens no namespaced tag as written, since a code block shows &lt; literally', () => {
    const samples = ['```cpp\nstd::vector<std::string> v;\n```', 'a < b, x<y:z>, <a:/>, <1:b c>']
    for (const text of samples) {
      expect(inertWidgets(text)).toBe(text)
    }
  })

  it('still escapes a real widget tag inside code, and an unfinished one at the end of the text', () => {
    const fenced = '```\n<widget:link-preview url="https://evil.example/x" source="1" />\n```'
    expect(rendersWidget(fenced)).toBe(true)
    expect(inertWidgets(fenced)).toBe(fenced.replace('<widget:', '&lt;widget:'))
    const unfinished = 'See <widget:link-preview url="https://evil.example/x"'
    expect(inertWidgets(unfinished)).toBe('See &lt;widget:link-preview url="https://evil.example/x"')
    expect(inertWidgets('See <widget:link-preview')).toBe('See &lt;widget:link-preview')
  })

  it('escapes every < that opens a namespaced tag, closed or not, and nothing the parser renders survives', () => {
    const pieces = ['<', 'a', 'b:', 'w:x', ' ', '/', '>', '/>', '-', 'q="1"', '\n', '【1】', '【2†t】', 'widget:']
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
    const opensTag = (text: string, i: number) => /^<[a-z][a-z0-9-]*:[a-z0-9-]*\s/i.test(text.slice(i))
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: 4 + (next() % 16) }, () => pieces[next() % pieces.length]).join('')
      const out = inertWidgets(text)
      expect({ text, live: rendersWidget(out) }).toEqual({ text, live: false })
      if (!text.includes('【')) {
        const expected = [...text].map((c, i) => (c === '<' && opensTag(text, i) ? '&lt;' : c)).join('')
        expect({ text, out }).toEqual({ text, out: expected })
      }
    }
    // A tag nested in another's attributes is live once the outer one is escaped, so both go.
    const nested = '<a:b <widget:link-preview url="https://evil.example/x" source="1" />'
    expect(inertWidgets(nested)).toBe(nested.replaceAll('<', '&lt;'))
  })
})

describe('renderSafe', () => {
  /** Milliseconds `fn` takes. */
  const timed = (fn: () => unknown) => {
    const start = performance.now()
    fn()
    return performance.now() - start
  }
  const spaces = ' '.repeat(200_000)
  // Each takes the old regexes, or the renderer's own, from seconds to minutes; a linear scan,
  // tens of milliseconds.
  const hostile = {
    'an unfinished widget tag before 200k spaces': `<widget:a${spaces}>x`,
    'a widget tag with an empty name before 200k spaces': `<widget:${spaces}>x`,
    '200k spaces after a <': `<${spaces}x`,
    'twenty thousand unclosed namespaced tags': '<a:b '.repeat(20_000),
    'forty thousand unclosed citation marks': '【1†'.repeat(40_000),
    'a citation mark after 200k spaces': `x${spaces}【1】`,
    'fifty thousand image openers': '!['.repeat(50_000),
  }

  for (const [name, text] of Object.entries(hostile)) {
    it(`stores ${name} in tens of milliseconds, and the renderer reads the result as fast`, () => {
      let stored = ''
      expect(timed(() => (stored = renderSafe(text)))).toBeLessThan(100)
      expect(timed(() => parseContentParts(stored))).toBeLessThan(100)
    })
  }

  it('gives the markdown renderer no image to fetch, only a link to click', () => {
    const parser = unified().use(remarkParse).use(remarkGfm)
    const nodeTypes = (markdown: string): string[] => {
      const types: string[] = []
      const walk = (node: { type: string; children?: unknown[] }) => {
        types.push(node.type)
        for (const child of node.children ?? []) {
          walk(child as { type: string; children?: unknown[] })
        }
      }
      walk(parser.parse(markdown))
      return types
    }
    const text = 'Seen ![pixel](https://evil.example/p.gif?c=1) and ![ref][r] here.\n\n[r]: https://evil.example/r.gif'
    expect(nodeTypes(text)).toEqual(expect.arrayContaining(['image', 'imageReference']))
    const stored = nodeTypes(renderSafe(text))
    expect(stored).not.toContain('image')
    expect(stored).not.toContain('imageReference')
    expect(stored).toEqual(expect.arrayContaining(['link', 'linkReference']))
  })

  it('applies to every pulled message, inside one event at the content cap', async () => {
    const content = `<widget:a${' '.repeat(inboundLimits.contentChars - 12)}>x`
    const raw = event({
      messages: [
        { id: 'm1', clientId: null, role: 'assistant', content, createdAt: '2026-10-20T12:00:01.000Z', origin: 'web' },
      ],
    })
    const start = performance.now()
    const [message] = (await toInbound(raw, ctx)).threads[0].messages
    expect(performance.now() - start).toBeLessThan(100)
    expect(message.text.startsWith('&lt;widget:a')).toBe(true)
  })

  it('keeps whitespace runs up to the cap, cuts longer ones, and changes nothing a reader can see', () => {
    const run = ' '.repeat(inboundLimits.whitespaceRun)
    expect(renderSafe(`a${run}b`)).toBe(`a${run}b`)
    expect(renderSafe(`a${run}\n\n\nb`)).toBe(`a${run}b`)
    expect(renderSafe('See 【1†Source】 and 【2】, then 【3†')).toBe('See 【1†Source】 and 【2】, then 【\u20603†')
    expect(parseContentParts(renderSafe('one 【1†x】 two 【2】'))).toEqual(parseContentParts('one 【1†x】 two 【2】'))
  })
})

describe('toPushBody', () => {
  it('says a body past the server’s conversation, message or size limit does not fit', () => {
    const row = {
      localId: 'm',
      remoteId: null,
      threadLocalId: 't',
      threadRemoteId: 'conv',
      role: 'user' as const,
      text: 'x',
      createdAt: 'x',
      deletedAt: null,
    }
    const thread = { localId: 't', remoteId: 'conv', title: 'T', createdAt: 'x', deletedAt: null }
    const body = (threads: number, messages: number, text = 'x') =>
      toPushBody({
        threads: Array.from({ length: threads }, () => thread),
        messages: Array.from({ length: messages }, () => ({ ...row, text })),
      })
    expect(fitsPushLimits(body(pushLimits.conversations, pushLimits.messages))).toBe(true)
    expect(fitsPushLimits(body(pushLimits.conversations + 1, 0))).toBe(false)
    expect(fitsPushLimits(body(0, pushLimits.messages + 1))).toBe(false)
    expect(fitsPushLimits(body(0, 25, 'x'.repeat(pushLimits.bodyBytes / 20)))).toBe(false)
  })

  it('names a conversation pushed in the same batch by its client id, and a known one by AI Potluck’s id', () => {
    const body = toPushBody({
      threads: [{ localId: 't1', remoteId: null, title: 'New', createdAt: 'x', deletedAt: null }],
      messages: [
        {
          localId: 'msg1',
          remoteId: null,
          threadLocalId: 't1',
          threadRemoteId: null,
          role: 'user',
          text: 'hello',
          createdAt: 'x',
          deletedAt: null,
        },
        {
          localId: 'msg2',
          remoteId: null,
          threadLocalId: 't2',
          threadRemoteId: 'conv-2',
          role: 'user',
          text: 'hi',
          createdAt: 'x',
          deletedAt: null,
        },
      ],
    })
    expect(body).toMatchObject({
      v: 1,
      conversations: [{ id: null, clientId: 't1', title: 'New' }],
      messages: [
        { clientId: 'msg1', conversationClientId: 't1', conversationId: null },
        { clientId: 'msg2', conversationClientId: null, conversationId: 'conv-2' },
      ],
    })
  })

  it('cuts a title to the server’s limit rather than having the conversation refused', () => {
    const body = toPushBody({
      threads: [{ localId: 't1', remoteId: null, title: 'x'.repeat(500), createdAt: 'x', deletedAt: null }],
      messages: [],
    })
    expect(body.conversations[0].title.length).toBe(200)
  })
})

describe('fromPushResponse', () => {
  it('reads acknowledgements and refusals by local id', () => {
    expect(
      fromPushResponse({
        v: 1,
        conversations: [{ clientId: 't1', id: 'c9' }],
        messages: [{ clientId: 'msg1', id: 'm9' }],
        rejected: [{ kind: 'message', clientId: 'msg2', reason: 'content_too_long' }],
      }),
    ).toEqual({
      threads: [{ localId: 't1', remoteId: 'c9' }],
      messages: [{ localId: 'msg1', remoteId: 'm9' }],
      rejected: [{ kind: 'message', localId: 'msg2', reason: 'content_too_long' }],
    })
  })

  it('treats a response without refusals as refusing nothing', () => {
    expect(fromPushResponse({ v: 1, conversations: [], messages: [] }).rejected).toEqual([])
  })
})

describe('changesEventV1Schema', () => {
  it('accepts the event shape the server sends', () => {
    expect(changesEventV1Schema.safeParse(event()).success).toBe(true)
  })
})

describe('mintMessageIds', () => {
  const ms = Date.parse('2026-10-20T12:00:00.000Z')
  const message = {
    clientId: null,
    role: 'user' as const,
    content: 'x',
    createdAt: '2026-10-20T12:00:00.000Z',
    origin: 'alpha',
  }

  it('gives different ids to pairs of conversation and message ids that join to the same text', async () => {
    const a = await mintMessageIds({ id: 'a:b', messages: [{ ...message, id: 'c' }] }, ms, ctx.now)
    const b = await mintMessageIds({ id: 'a', messages: [{ ...message, id: 'b:c' }] }, ms, ctx.now)
    expect(a.get('c')).not.toBe(b.get('b:c'))
    expect(messageSeed('a:b', 'c')).not.toBe(messageSeed('a', 'b:c'))
  })

  it('keeps the seed AI Potluck’s export uses for ids without a colon, so both mint the same id', async () => {
    const ids = await mintMessageIds({ id: 'conv-1', messages: [{ ...message, id: 'm1' }] }, ms, ctx.now)
    expect(ids.get('m1')).toBe(uuidv7At(ms, 'alpha-message:conv-1:m1'))
  })
})
