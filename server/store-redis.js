// Redis store (Vercel serverless + production). Same interface as store-json.js.
// Users live in `user:<id>` hashes, nicknames indexed at `nick:<lower>`,
// nonces are single-use keys with TTL, IP buckets are sorted sets.
// Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
import { Redis } from '@upstash/redis'
import { randomUUID } from 'crypto'
import {
  NONCE_TTL_MS, IP_WINDOW_MS, IP_MAX_TICKS,
  RENAME_LIMIT, RENAME_WINDOW_MS, ONLINE_MS, USER_TTL_SECONDS, publicIdFor
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
  const pipe = redis.pipeline()
  pipe.hset(U(u.id), serialize(u))
  pipe.expire(U(u.id), USER_TTL_SECONDS)
  await pipe.exec()
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

// Atomic create: nick-NX check + user write + set add in ONE Lua script.
// No TOCTOU between the uniqueness check and the write, even across instances.
const CREATE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {'taken'} end
local u = cjson.decode(ARGV[1])
local flat = {}
for k, v in pairs(u) do table.insert(flat, k); table.insert(flat, v) end
redis.call('HSET', KEYS[1], unpack(flat))
redis.call('SADD', KEYS[3], ARGV[2])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return {'ok'}
`

export async function createUser(id, nickname, ipHash, fpHash) {
  const now = new Date().toISOString()
  const u = normalize({
    id, nickname, totalMs: 0, createdAt: now, lastSeen: now,
    ipHashes: ipHash ? [ipHash] : [], fpHashes: fpHash ? [fpHash] : []
  })
  const res = await redis.eval(CREATE_LUA, [U(id), N(nickname), USERS_KEY],
    [JSON.stringify(serialize(u)), id, String(USER_TTL_SECONDS)])
  if (!res || res[0] !== 'ok') return { error: 'taken' }
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

// Atomic tick: replay guard + min-interval guard + server-clock delta + daily
// cap + write, ALL inside one Lua script. Parallel serverless invocations
// can no longer double-credit or overrun the cap.
const TICK_LUA = `
local raw = redis.call('HGETALL', KEYS[1])
if #raw == 0 then return {'unknown'} end
local f = {}
for i = 1, #raw, 2 do f[raw[i]] = raw[i + 1] end
if not f.id then return {'unknown'} end
local seq = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local lastSeq = tonumber(f.lastSeq or 0)
if seq <= lastSeq then return {'replay', tonumber(f.totalMs or 0)} end
local lastHb = tonumber(f.lastHeartbeatMs or 0)
if lastHb > 0 and (now - lastHb) < tonumber(ARGV[3]) then return {'fast', tonumber(f.totalMs or 0)} end
local elapsed = lastHb > 0 and (now - lastHb) or tonumber(ARGV[5])
local delta = math.max(0, math.min(elapsed, tonumber(ARGV[4])))
local dailyMs = tonumber(f.dailyMs or 0)
local today = ARGV[10]
if (f.dailyDate or '') ~= today then dailyMs = 0 end
local cap = tonumber(ARGV[6])
local credited = delta
local capped = 0
local cappedDays = tonumber(f.cappedDays or 0)
local flags = cjson.decode(f.flags or '[]')
local function contains(t, v)
  for _, x in ipairs(t) do if x == v then return true end end
  return false
end
if dailyMs + delta >= cap then
  credited = math.max(0, cap - dailyMs)
  capped = 1
  cappedDays = cappedDays + 1
  if not contains(flags, 'daily-cap') then table.insert(flags, 'daily-cap') end
end
dailyMs = dailyMs + credited
local totalMs = tonumber(f.totalMs or 0) + credited
local iph = cjson.decode(f.ipHashes or '[]')
if ARGV[8] ~= '' and not contains(iph, ARGV[8]) then table.insert(iph, ARGV[8]) end
local fph = cjson.decode(f.fpHashes or '[]')
if ARGV[9] ~= '' and not contains(fph, ARGV[9]) then table.insert(fph, ARGV[9]) end
redis.call('HSET', KEYS[1],
  'lastSeq', seq,
  'lastHeartbeatMs', now,
  'activeSessionId', ARGV[7],
  'lastSeen', ARGV[11],
  'dailyMs', dailyMs,
  'dailyDate', today,
  'totalMs', totalMs,
  'cappedDays', cappedDays,
  'flags', cjson.encode(flags),
  'ipHashes', cjson.encode(iph),
  'fpHashes', cjson.encode(fph))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[12]))
return {'ok', totalMs, credited, capped, dailyMs}
`

export async function creditTick(id, { seq, sessionId, ipHash, fpHash, heartbeatExpectMs, maxCreditMs, minTickMs, dailyCapMs }) {
  const now = Date.now()
  const res = await redis.eval(TICK_LUA, [U(id)], [
    String(seq), String(now), String(minTickMs), String(maxCreditMs),
    String(heartbeatExpectMs), String(dailyCapMs), sessionId || '',
    ipHash || '', fpHash || '',
    todayStr(), new Date().toISOString(), String(USER_TTL_SECONDS)
  ])
  if (!res || res[0] === 'unknown') return { error: 'unknown' }
  if (res[0] === 'replay') return { error: 'replay', totalMs: Number(res[1]) || 0 }
  if (res[0] === 'fast') return { error: 'fast', totalMs: Number(res[1]) || 0 }
  const user = await getUserById(id)
  return {
    user,
    credited: Number(res[2]) || 0,
    capped: res[3] === 1 || res[3] === '1'
  }
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

// Atomic rename: uniqueness check + quota check + write + index swap in ONE
// Lua script. Two users racing for the same nickname can't both win, and the
// quota can't be double-consumed.
const RENAME_LUA = `
local raw = redis.call('HGETALL', KEYS[1])
if #raw == 0 then return {'unknown'} end
local f = {}
for i = 1, #raw, 2 do f[raw[i]] = raw[i + 1] end
if not f.id then return {'unknown'} end
local id = ARGV[1]
local newNick = ARGV[2]
local now = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local windowMs = tonumber(ARGV[5])
local winStart = tonumber(f.renameWindowStart or 0)
local count = tonumber(f.renameCount or 0)
if winStart == 0 or (now - winStart) >= windowMs then
  winStart = now
  count = 0
end
local taken = redis.call('GET', KEYS[2])
if taken and taken ~= id then
  redis.call('HSET', KEYS[1], 'renameWindowStart', winStart, 'renameCount', count)
  return {'taken'}
end
if count >= limit then
  redis.call('HSET', KEYS[1], 'renameWindowStart', winStart, 'renameCount', count)
  return {'limited', winStart + windowMs}
end
local old = f.nickname or ''
count = count + 1
local function contains(t, v)
  for _, x in ipairs(t) do if x == v then return true end end
  return false
end
local iph = cjson.decode(f.ipHashes or '[]')
if ARGV[6] ~= '' and not contains(iph, ARGV[6]) then table.insert(iph, ARGV[6]) end
local fph = cjson.decode(f.fpHashes or '[]')
if ARGV[7] ~= '' and not contains(fph, ARGV[7]) then table.insert(fph, ARGV[7]) end
redis.call('HSET', KEYS[1],
  'nickname', newNick,
  'renameWindowStart', winStart,
  'renameCount', count,
  'lastSeen', ARGV[8],
  'ipHashes', cjson.encode(iph),
  'fpHashes', cjson.encode(fph))
redis.call('SET', KEYS[2], id)
if string.lower(old) ~= string.lower(newNick) then redis.call('DEL', KEYS[3]) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[9]))
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[9]))
local totalMs = tonumber(f.totalMs or 0)
return {'ok', old, totalMs, limit - count, winStart + windowMs}
`

export async function renameUser(id, newNickname, { ipHash, fpHash }) {
  const existing = await getUserById(id)
  if (!existing) return { error: 'unknown' }
  const res = await redis.eval(RENAME_LUA,
    [U(id), N(newNickname), N(existing.nickname)],
    [id, newNickname, String(Date.now()), String(RENAME_LIMIT), String(RENAME_WINDOW_MS),
     ipHash || '', fpHash || '', new Date().toISOString(), String(USER_TTL_SECONDS)])
  if (!res || res[0] === 'unknown') return { error: 'unknown' }
  if (res[0] === 'taken') return { error: 'taken' }
  if (res[0] === 'limited') return { error: 'limited', resetAtMs: Number(res[1]) || 0 }
  await audit({ kind: 'rename', userId: id, from: String(res[1]), to: newNickname, ip: ipHash, fp: fpHash })
  const user = await getUserById(id)
  return {
    user,
    old: String(res[1]),
    remaining: Number(res[3]) || 0,
    resetAtMs: Number(res[4]) || 0
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

// Atomic sliding window: trim + count + conditional add in ONE Lua script,
// so a Vercel autoscale burst can't slip past IP_MAX_TICKS.
const IP_ALLOW_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[5])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`

export async function ipAllowed(ip) {
  const now = Date.now()
  const res = await redis.eval(IP_ALLOW_LUA, [IP(ip)], [
    String(now), String(IP_WINDOW_MS), String(IP_MAX_TICKS),
    String(Math.ceil(IP_WINDOW_MS / 1000) + 1), `${now}:${randomUUID()}`
  ])
  return res === 1
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
      publicId: publicIdFor(u.id),
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

/** GDPR purge: delete account + free the nickname. Returns true if existed. */
export async function deleteUser(id) {
  if (!id || typeof id !== 'string') return false
  const u = await getUserById(id)
  if (!u) return false
  const pipe = redis.pipeline()
  pipe.del(U(id))
  pipe.srem(USERS_KEY, id)
  pipe.del(N(u.nickname))
  await pipe.exec()
  return true
}

/** Test-only escape hatch. Refuses outside NODE_ENV=test. */
export async function __testWipe() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only')
  await redis.flushdb()
}
