// Redis store (Vercel serverless + production). Same interface as store-json.js.
// Users live in `user:<id>` hashes, nicknames indexed at `nick:<lower>`,
// nonces are single-use keys with TTL, IP buckets are sorted sets.
// Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
import { Redis } from '@upstash/redis'
import { randomUUID } from 'crypto'
import {
  NONCE_TTL_MS, IP_WINDOW_MS, IP_MAX_TICKS, DAILY_CAP_MS,
  RENAME_LIMIT, RENAME_WINDOW_MS, ONLINE_MS
} from './config.js'

const redis = Redis.fromEnv()

const U = id => `user:${id}`
const N = nick => `nick:${String(nick).toLowerCase()}`
const NP = nonce => `nonce:${nonce}`
const IP = ip => `ip:${ip}`
const AUDIT_KEY = 'audit'
const USERS_KEY = 'users'

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function arr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      return Array.isArray(p) ? p : []
    } catch { return [] }
  }
  return []
}

/** Apply schema defaults so old/partial records never crash readers. */
function normalize(raw) {
  if (!raw || !raw.id) return null
  const today = new Date().toISOString().slice(0, 10)
  const u = {
    id: String(raw.id),
    nickname: String(raw.nickname ?? '???'),
    totalMs: num(raw.totalMs),
    createdAt: raw.createdAt || new Date().toISOString(),
    lastSeen: raw.lastSeen || new Date().toISOString(),
    lastHeartbeatMs: num(raw.lastHeartbeatMs),
    lastSeq: num(raw.lastSeq),
    activeSessionId: raw.activeSessionId || null,
    sessionStartMs: num(raw.sessionStartMs),
    dailyMs: num(raw.dailyMs),
    dailyDate: raw.dailyDate || today,
    ipHashes: arr(raw.ipHashes),
    fpHashes: arr(raw.fpHashes),
    concurrentHits: num(raw.concurrentHits),
    cappedDays: num(raw.cappedDays),
    renameCount: num(raw.renameCount),
    renameWindowStart: num(raw.renameWindowStart),
    flags: arr(raw.flags)
  }
  if (u.dailyDate !== today) {
    u.dailyDate = today
    u.dailyMs = 0
  }
  return u
}

function serialize(u) {
  return {
    ...u,
    activeSessionId: u.activeSessionId || '',
    ipHashes: JSON.stringify(u.ipHashes),
    fpHashes: JSON.stringify(u.fpHashes),
    flags: JSON.stringify(u.flags)
  }
}

async function writeUser(u) {
  await redis.hset(U(u.id), serialize(u))
}

async function readAllUsers() {
  const ids = await redis.smembers(USERS_KEY)
  if (!ids.length) return []
  const pipe = redis.pipeline()
  for (const id of ids) pipe.hgetall(U(id))
  const raws = await pipe.exec()
  const out = []
  for (const raw of raws) {
    const u = normalize(raw)
    if (u) out.push(u)
  }
  return out
}

// ================= users =================

export function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

export async function getUserById(id) {
  if (!id) return null
  const u = normalize(await redis.hgetall(U(id)))
  if (!u) return null
  if (u.dailyMs === 0 && u.dailyDate === todayStr()) {
    // rollover already applied in normalize; persist it cheaply
    await redis.hset(U(id), { dailyDate: u.dailyDate, dailyMs: 0 })
  }
  return u
}

export async function getUserByNickname(nickname) {
  const id = await redis.get(N(nickname))
  if (!id) return null
  return getUserById(id)
}

export async function createUser(id, nickname, ipHash, fpHash) {
  const now = new Date().toISOString()
  const u = normalize({
    id, nickname, totalMs: 0, createdAt: now, lastSeen: now,
    ipHashes: ipHash ? [ipHash] : [], fpHashes: fpHash ? [fpHash] : []
  })
  const pipe = redis.pipeline()
  pipe.hset(U(id), serialize(u))
  pipe.sadd(USERS_KEY, id)
  pipe.set(N(nickname), id)
  await pipe.exec()
  return u
}

export async function countNicksByIpToday(ipHash) {
  const today = todayStr()
  let n = 0
  for (const u of await readAllUsers()) {
    if (u.createdAt?.slice(0, 10) === today && u.ipHashes.includes(ipHash)) n++
  }
  return n
}

export async function countIdsByFp(fpHash) {
  if (!fpHash) return 0
  let n = 0
  for (const u of await readAllUsers()) {
    if (u.fpHashes.includes(fpHash)) n++
  }
  return n
}

export async function touchSeen(id) {
  const u = await getUserById(id)
  if (!u) return null
  u.lastSeen = new Date().toISOString()
  await writeUser(u)
  return u
}

export async function addFlag(id, flag) {
  const u = await getUserById(id)
  if (!u) return null
  if (!u.flags.includes(flag)) {
    u.flags.push(flag)
    await writeUser(u)
  }
  return u
}

export async function creditTime(id, deltaMs, { sessionId, ipHash, fpHash, dailyCapMs }) {
  const u = await getUserById(id)
  if (!u) return null
  u.activeSessionId = sessionId
  u.lastHeartbeatMs = Date.now()
  u.lastSeen = new Date().toISOString()
  if (ipHash && !u.ipHashes.includes(ipHash)) u.ipHashes.push(ipHash)
  if (fpHash && !u.fpHashes.includes(fpHash)) u.fpHashes.push(fpHash)

  let credited = deltaMs
  let capped = false
  if (u.dailyMs + deltaMs >= dailyCapMs) {
    credited = Math.max(0, dailyCapMs - u.dailyMs)
    capped = true
    u.cappedDays += 1
    if (!u.flags.includes('daily-cap')) u.flags.push('daily-cap')
  }
  u.dailyMs += credited
  u.totalMs += credited
  await writeUser(u)
  return { user: u, credited, capped }
}

export async function setSession(id, sessionId) {
  const u = await getUserById(id)
  if (!u) return null
  u.activeSessionId = sessionId
  u.sessionStartMs = Date.now()
  u.lastHeartbeatMs = Date.now()
  u.lastSeen = new Date().toISOString()
  await writeUser(u)
  return u
}

export async function bumpSeq(id, seq) {
  const exists = await redis.exists(U(id))
  if (!exists) return null
  await redis.hset(U(id), { lastSeq: seq })
  return getUserById(id)
}

export async function bumpConcurrent(id) {
  const u = await getUserById(id)
  if (!u) return null
  u.concurrentHits += 1
  if (u.concurrentHits >= 3 && !u.flags.includes('concurrent')) u.flags.push('concurrent')
  await writeUser(u)
  return u
}

// ================= rename quota =================

export async function getRenameStatus(id) {
  const u = await getUserById(id)
  if (!u) return null
  const now = Date.now()
  if (!u.renameWindowStart || now - u.renameWindowStart >= RENAME_WINDOW_MS) {
    return { remaining: RENAME_LIMIT, resetAtMs: 0 }
  }
  return {
    remaining: Math.max(0, RENAME_LIMIT - (u.renameCount || 0)),
    resetAtMs: u.renameWindowStart + RENAME_WINDOW_MS
  }
}

export async function renameUser(id, newNickname, { ipHash, fpHash }) {
  const u = await getUserById(id)
  if (!u) return { error: 'unknown' }
  const now = Date.now()
  if (!u.renameWindowStart || now - u.renameWindowStart >= RENAME_WINDOW_MS) {
    u.renameWindowStart = now
    u.renameCount = 0
  }

  // uniqueness first — taken names never consume quota
  const takenId = await redis.get(N(newNickname))
  if (takenId && takenId !== id) {
    await writeUser(u) // persist possible window roll
    return { error: 'taken' }
  }

  if ((u.renameCount || 0) >= RENAME_LIMIT) {
    await writeUser(u)
    return { error: 'limited', resetAtMs: u.renameWindowStart + RENAME_WINDOW_MS }
  }

  const old = u.nickname
  u.nickname = newNickname
  u.renameCount = (u.renameCount || 0) + 1
  u.lastSeen = new Date().toISOString()
  if (ipHash && !u.ipHashes.includes(ipHash)) u.ipHashes.push(ipHash)
  if (fpHash && !u.fpHashes.includes(fpHash)) u.fpHashes.push(fpHash)

  const pipe = redis.pipeline()
  pipe.hset(U(id), serialize(u))
  pipe.set(N(newNickname), id)
  if (old.toLowerCase() !== newNickname.toLowerCase()) pipe.del(N(old))
  await pipe.exec()
  await audit({ kind: 'rename', userId: id, from: old, to: newNickname, ip: ipHash, fp: fpHash })
  return {
    user: u,
    old,
    remaining: Math.max(0, RENAME_LIMIT - u.renameCount),
    resetAtMs: u.renameWindowStart + RENAME_WINDOW_MS
  }
}

// ================= ephemeral primitives (Redis-backed, cross-instance) =================

export async function issueNonce() {
  for (let i = 0; i < 3; i++) {
    const nonce = randomUUID()
    const set = await redis.set(NP(nonce), '1', { nx: true, ex: Math.ceil(NONCE_TTL_MS / 1000) })
    if (set === 'OK') return nonce
  }
  throw new Error('nonce collision — retry')
}

export async function consumeNonce(nonce) {
  if (typeof nonce !== 'string' || !nonce) return false
  const v = await redis.getdel(NP(nonce)) // atomic get+delete: single use even across instances
  return v !== null
}

export async function ipAllowed(ip) {
  const key = IP(ip)
  const now = Date.now()
  await redis.zremrangebyscore(key, 0, now - IP_WINDOW_MS)
  const count = await redis.zcard(key)
  if (count >= IP_MAX_TICKS) return false
  const pipe = redis.pipeline()
  pipe.zadd(key, { score: now, member: `${now}:${randomUUID()}` })
  pipe.expire(key, Math.ceil(IP_WINDOW_MS / 1000) + 1)
  await pipe.exec()
  return true
}

/** Test-only: no in-memory state in this store. */
export async function __resetEphemeral() { /* nothing ephemeral here */ }

// ================= audit + reads =================

/** Capped list (1000 entries) — routine accepted ticks are NOT logged (see index.js),
 *  only lifecycle events + rejects, so the free tier isn't burned by heartbeats. */
export async function audit(entry) {
  try {
    const pipe = redis.pipeline()
    pipe.lpush(AUDIT_KEY, JSON.stringify({ ts: new Date().toISOString(), ...entry }))
    pipe.ltrim(AUDIT_KEY, 0, 999)
    await pipe.exec()
  } catch { /* best effort */ }
}

export async function getLeaderboard(limit = 50) {
  const now = Date.now()
  return (await readAllUsers())
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
    .map(u => ({
      id: u.id,
      nickname: u.nickname,
      totalMs: u.totalMs,
      online: now - (u.lastHeartbeatMs || 0) < ONLINE_MS
    }))
}

export async function getRank(id) {
  const sorted = (await readAllUsers()).sort((a, b) => b.totalMs - a.totalMs)
  const idx = sorted.findIndex(u => u.id === id)
  return idx === -1 ? null : idx + 1
}

export async function getFlagged() {
  return (await readAllUsers())
    .filter(u => u.flags.length > 0 || u.ipHashes.length > 3 || u.fpHashes.length > 3 || u.concurrentHits > 0)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 100)
    .map(u => ({
      id: u.id,
      nickname: u.nickname,
      totalMs: u.totalMs,
      dailyMs: u.dailyMs,
      flags: u.flags,
      ipCount: u.ipHashes.length,
      fpCount: u.fpHashes.length,
      concurrentHits: u.concurrentHits,
      lastSeen: u.lastSeen
    }))
}

/** Test-only escape hatch. Refuses outside NODE_ENV=test. */
export async function __testWipe() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only')
  await redis.flushdb()
}
