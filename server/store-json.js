// JSON-file store (local dev + tests). Re-exports db.js and adds the
// ephemeral anti-abuse primitives (single-use nonces, per-IP sliding window)
// so every store behind store.js exposes the same interface.
export * from './db.js'

import { randomUUID } from 'crypto'
import { NONCE_TTL_MS, IP_WINDOW_MS, IP_MAX_TICKS } from './config.js'

// ---- single-use challenge nonces ----
const nonces = new Map() // nonce -> expiresAt
setInterval(() => {
  const now = Date.now()
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n)
}, 30_000).unref()

export function issueNonce() {
  const nonce = randomUUID()
  nonces.set(nonce, Date.now() + NONCE_TTL_MS)
  return nonce
}

export function consumeNonce(nonce) {
  const exp = nonces.get(nonce)
  if (!exp) return false
  nonces.delete(nonce)
  return exp >= Date.now()
}

// ---- per-IP sliding-window rate limiter ----
const ipHits = new Map() // ipHash -> number[]

export function ipAllowed(ip) {
  const now = Date.now()
  let arr = ipHits.get(ip) || []
  arr = arr.filter(t => now - t < IP_WINDOW_MS)
  if (arr.length >= IP_MAX_TICKS) {
    ipHits.set(ip, arr)
    return false
  }
  arr.push(now)
  ipHits.set(ip, arr)
  return true
}

/** Test-only: clear in-memory buckets (db wipe lives in db.js __testWipe). */
export function __resetEphemeral() {
  nonces.clear()
  ipHits.clear()
}
