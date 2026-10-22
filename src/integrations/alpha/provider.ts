/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The "external sync provider" seam.
 *
 * A provider speaks to one outside service (AI Potluck today) and translates between that service's
 * wire shape and the Thunderbolt-shaped rows below. Everything Thunderbolt-specific (the id map,
 * echo suppression, DAL writes, watching local tables) lives in the engine (`engine.ts`), which
 * talks to the service only through this type. The engine is not yet provider-agnostic: it imports
 * AI Potluck's push limits, `local-reads.ts` recognises chats by AI Potluck's minted ids, and the
 * two tables it keeps are AI Potluck's own. Making a second provider possible would need the steps
 * under "What upstream would need" in the README.
 *
 * Every local write the engine makes goes through Thunderbolt's DAL, so PowerSync encrypts it and
 * carries it to the account's other devices like any other edit; a provider never sees a key.
 */

import type { UIMessageMetadata } from '@/types'

export type SyncRole = 'user' | 'assistant'

export type InboundMessage = {
  remoteId: string
  /** The local id this row claims (an echo) or a deterministic one minted from the remote row. */
  localId: string
  /** True when the row says this app pushed it. The engine accepts the claim only if it can confirm it. */
  isEcho: boolean
  role: SyncRole
  text: string
  createdAt: string
  /** The local message's metadata: where the row came from, under the provider's own key. */
  metadata: UIMessageMetadata
}

export type InboundThread = {
  remoteId: string
  localId: string
  isEcho: boolean
  title: string
  /** The remote's live branch, oldest first. */
  messages: InboundMessage[]
  /**
   * Remote ids of messages on the live branch that this device could not give an id (dated too far
   * ahead of its clock). They are still there, so a copy already here is kept.
   */
  unplaced?: string[]
}

export type InboundTombstone = {
  kind: 'thread' | 'message'
  remoteId: string
  deletedAt: string
}

/** Why a remote conversation was skipped rather than applied. Each is decided on this device. */
export type SkipReason = 'too-large' | 'too-many' | 'unreadable'

/**
 * A conversation in the batch that could not be applied (past a size limit, or unreadable). The
 * batch is still applied and its cursor saved, and the skip is recorded as not synced.
 */
export type InboundSkip = {
  /** The conversation, or null when not even its id could be read. */
  remoteId: string | null
  reason: SkipReason
}

export type InboundBatch = {
  /** Where the stream resumes after this batch, or null when the stream has not given one yet. */
  cursor: string | null
  threads: InboundThread[]
  tombstones: InboundTombstone[]
  skipped?: InboundSkip[]
}

export type OutboundThread = {
  localId: string
  remoteId: string | null
  title: string | null
  createdAt: string
  deletedAt: string | null
}

export type OutboundMessage = {
  localId: string
  remoteId: string | null
  threadLocalId: string | null
  threadRemoteId: string | null
  role: SyncRole
  text: string
  createdAt: string
  deletedAt: string | null
}

export type OutboundBatch = {
  threads: OutboundThread[]
  messages: OutboundMessage[]
}

export type PushAck = {
  threads: { localId: string; remoteId: string }[]
  messages: { localId: string; remoteId: string }[]
  /** Rows the remote refused, with its reason. */
  rejected: { kind: 'thread' | 'message'; localId: string; reason: string }[]
}

export type ExternalSyncProvider = {
  id: string
  /**
   * Live changes after `cursor` (null = everything). Yields until the remote closes the stream,
   * then returns; the engine reconnects with the last cursor. Throws on transport or auth failure.
   */
  changes: (cursor: string | null, signal: AbortSignal) => AsyncIterable<InboundBatch>
  /** Idempotent: pushing the same rows twice must not duplicate them remotely. */
  push: (batch: OutboundBatch, signal: AbortSignal) => Promise<PushAck>
}
