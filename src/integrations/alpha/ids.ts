/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/*
 * Thunderbolt's chat rows have no created-at column: both tables sort by id, a UUIDv7 whose first
 * 48 bits are Unix milliseconds. These helpers read and mint those ids.
 */

const formatUuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`

const msHex = (ms: number) => Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').slice(-12)

/**
 * A UUIDv7 for `ms` whose other 74 bits come from SHA-256 of `seed`, so the same seed and time always
 * give the same id on every device. Layout: 48 bits of milliseconds, version 7, then the first ten
 * bytes of the hash with the variant bits set.
 */
export const uuidv7At = (ms: number, seed: string): string => {
  const hash = sha256(new TextEncoder().encode(seed))
  const bytes = new Uint8Array(16)
  let t = Math.max(0, Math.floor(ms))
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256
    t = Math.floor(t / 256)
  }
  bytes.set(hash.subarray(0, 10), 6)
  bytes[6] = 0x70 | (bytes[6] & 0x0f)
  bytes[8] = 0x80 | (bytes[8] & 0x3f)
  return formatUuid(bytesToHex(bytes))
}

const uuidv7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The milliseconds a UUIDv7 carries, or null when `id` is not a UUIDv7. */
export const uuidv7Ms = (id: string): number | null =>
  uuidv7Pattern.test(id) ? parseInt(id.replace(/-/g, '').slice(0, 12), 16) : null

/** The time a UUIDv7 carries, as an ISO string (the epoch for anything else). */
export const uuidv7Iso = (id: string): string => new Date(uuidv7Ms(id) ?? 0).toISOString()

/** The smallest UUIDv7 for `ms`: every id minted at or after `ms` sorts at or above it. */
export const uuidv7Floor = (ms: number): string => formatUuid(`${msHex(ms)}7000${'8'.padEnd(16, '0')}`)

/**
 * A stable fingerprint of a text, to notice when a synced text changed: the first 128 bits of its
 * SHA-256, synchronous so the pure planners can call it.
 */
export const textHash = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text))).slice(0, 32)
