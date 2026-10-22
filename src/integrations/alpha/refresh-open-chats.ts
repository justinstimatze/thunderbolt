/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { UIMessage } from 'ai'
import { useChatStore } from '@/chats/chat-store'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getChatMessages } from '@/dal/chat-messages'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import type { InboundTouched } from './engine'
import { readProvenance } from './provenance'

type Deps = {
  store?: Pick<typeof useChatStore, 'getState'>
  read?: typeof getChatMessages
}

const sameMessages = (a: readonly UIMessage[], b: readonly UIMessage[]) =>
  a.length === b.length &&
  a.every(
    (m, i) =>
      m.id === b[i].id &&
      m.role === b[i].role &&
      JSON.stringify(m.parts) === JSON.stringify(b[i].parts) &&
      JSON.stringify(m.metadata ?? {}) === JSON.stringify(b[i].metadata ?? {}),
  )

/**
 * The chat's messages as the database holds them, with this device's own messages kept as the view
 * has them. Sync writes only AI Potluck's rows; this device's are saved by the chat itself, and the
 * view can be ahead of that save (a reply has finished on screen and its save is still running).
 * Null when the view holds one of this device's messages the database doesn't have yet.
 */
const merge = (view: ThunderboltUIMessage[], rows: ThunderboltUIMessage[]): ThunderboltUIMessage[] | null => {
  const read = new Set(rows.map((m) => m.id))
  const own = new Map(view.filter((m) => !readProvenance(m.metadata)).map((m) => [m.id, m]))
  for (const id of own.keys()) {
    if (!read.has(id)) {
      return null
    }
  }
  return rows.map((m) => own.get(m.id) ?? m)
}

/**
 * Re-read the messages of open chats an inbound batch wrote into. A chat is loaded into memory once,
 * when it is first opened, and its view shows that copy; without this, a reply AI Potluck filled in
 * after the question synced stays hidden until the page reloads. A chat with a turn of its own in
 * progress here (sending, receiving, failed, or waiting to retry) is left alone: its next open reads
 * the database again.
 */
export const refreshOpenChats = async (
  db: AnyDrizzleDatabase,
  threads: InboundTouched,
  { store = useChatStore, read = getChatMessages }: Deps = {},
): Promise<void> => {
  const open = store.getState().sessions
  const ids = threads === 'all' ? [...open.keys()] : threads.filter((id) => open.has(id))
  for (const id of ids) {
    const rows = await read(db, id)
    // Read the session after the await: it may have started a turn, or closed, meanwhile.
    const session = store.getState().sessions.get(id)
    const chat = session?.chatInstance
    if (!session || !chat || chat.status !== 'ready' || session.retryCount > 0) {
      continue
    }
    const next = merge(chat.messages, rows.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[])
    if (!next || sameMessages(chat.messages, next)) {
      continue
    }
    chat.messages = next
    // As at hydration: a trailing empty reply is not one this device should try to recover.
    const last = next.at(-1)
    store.getState().updateSession(id, { retriesExhausted: last?.role === 'assistant' && !last.parts?.length })
  }
}

/**
 * Runs {@link refreshOpenChats} one pass at a time. Chats named while a pass runs are gathered into
 * the next one, so a burst of batches costs one re-read per open chat rather than one per batch.
 */
export const createOpenChatRefresher = (db: AnyDrizzleDatabase, deps: Deps = {}) => {
  let pending: Set<string> | 'all' | null = null
  let running: Promise<void> | null = null
  const run = async () => {
    while (pending) {
      const threads = pending === 'all' ? 'all' : [...pending]
      pending = null
      await refreshOpenChats(db, threads, deps).catch(() => {})
    }
    running = null
  }
  return (threads: InboundTouched): Promise<void> => {
    if (threads === 'all' || pending === 'all') {
      pending = 'all'
    } else {
      pending = new Set([...(pending ?? []), ...threads])
    }
    running ??= run()
    return running
  }
}
