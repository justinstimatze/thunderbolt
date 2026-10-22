/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { textHash, uuidv7At, uuidv7Floor, uuidv7Iso, uuidv7Ms } from './ids'

describe('uuidv7At', () => {
  it('matches AI Potluck’s implementation byte for byte, so its file export and sync agree on ids', () => {
    // Synchronous: one SHA-256 implementation (@noble/hashes) serves both uuidv7At and textHash.
    expect(uuidv7At(Date.parse('2026-10-20T12:00:00.000Z'), 'alpha-thread:conv-1')).toBe(
      '01a1592e-c600-7452-8d6f-0b7a0a2bcbd1',
    )
  })

  it('is deterministic per seed and carries its time', () => {
    const ms = Date.parse('2026-10-20T12:00:00.000Z')
    const a = uuidv7At(ms, 'seed')
    expect(uuidv7At(ms, 'seed')).toBe(a)
    expect(uuidv7At(ms, 'other')).not.toBe(a)
    expect(uuidv7Iso(a)).toBe('2026-10-20T12:00:00.000Z')
  })
})

describe('uuidv7Floor', () => {
  it('sorts at or below every UUIDv7 minted at or after its time, and above every earlier one', () => {
    const ms = Date.parse('2026-10-20T12:00:00.000Z')
    const floor = uuidv7Floor(ms)
    expect(uuidv7Ms(floor)).toBe(ms)
    expect(uuidv7({ msecs: ms }) >= floor).toBe(true)
    expect(uuidv7({ msecs: ms + 1 }) > floor).toBe(true)
    expect(uuidv7({ msecs: ms - 1 }) < floor).toBe(true)
  })
})

describe('uuidv7Ms', () => {
  it('returns null for anything that is not a UUIDv7, so a claimed id is never trusted for its time', () => {
    expect(uuidv7Ms('not-an-id')).toBeNull()
    expect(uuidv7Ms('0f8fad5b-d9cb-469f-a165-70867728950e')).toBeNull()
  })
})

describe('textHash', () => {
  it('is stable for a text and changes with it', () => {
    expect(textHash('About an hour.')).toBe(textHash('About an hour.'))
    expect(textHash('About an hour.')).not.toBe(textHash('About two hours.'))
  })
})

describe('textHash', () => {
  it('tells apart two texts that collide under a 32-bit hash, so an edit is never mistaken for agreement', () => {
    // These two collide under 32-bit FNV-1a.
    expect(textHash('reply 58576')).not.toBe(textHash('reply 898620'))
    expect(textHash('same')).toBe(textHash('same'))
  })
})
