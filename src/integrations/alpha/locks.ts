/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Held by the one tab per browser that runs the bridge. */
export const engineLockName = 'alpha-sync-engine'

/** Held while reading, refreshing or deleting the stored tokens, so only one refresh is ever in flight. */
export const credentialsLockName = 'alpha-sync-credentials'

const localChains = new Map<string, Promise<unknown>>()

/** In-process stand-in for the Web Locks API (tests, and browsers without it). */
const withLocalLock = <T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  const previous = localChains.get(name) ?? Promise.resolve()
  let started = false
  const run = async () => {
    signal?.throwIfAborted()
    started = true
    return fn()
  }
  const next = previous.then(run, run)
  const settled = next.catch(() => undefined)
  localChains.set(name, settled)
  void settled.then(() => {
    if (localChains.get(name) === settled) {
      localChains.delete(name)
    }
  })
  if (!signal) {
    return next
  }
  // Like the Web Locks API: an abort ends the wait, never a holder that already started.
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!started) {
        reject(signal.reason)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    next.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Run `fn` while holding the named lock, shared by every tab of this origin. Waits for the lock;
 * `signal` abandons the wait (the returned promise rejects with an AbortError).
 */
export const withLock = <T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) {
    return withLocalLock(name, fn, signal)
  }
  return locks.request(name, signal ? { signal } : {}, fn) as Promise<T>
}
