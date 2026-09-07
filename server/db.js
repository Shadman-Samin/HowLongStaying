import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, 'data')
const DB_FILE = join(DATA_DIR, 'db.json')
const AUDIT_FILE = join(DATA_DIR, 'audit.log.ndjson')

import { RENAME_LIMIT, RENAME_WINDOW_MS, AUDIT_MAX_BYTES } from './config.js'

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

export function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10) // UTC YYYY-MM-DD
}

function load() {
  try {
    if (!existsSync(DB_FILE)) {
      const fresh = { users: {} }
      writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2))
      return fresh
    }
    return JSON.parse(readFileSync(DB_FILE, 'utf-8'))
  } catch {
    return { users: {} }
  }
}

function save(db) {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

/** Migrate old records to the anti-cheat schema (backwards compatible). */
function migrate(u) {
  let dirty = false
  const defaults = {
    totalMs: 0,
    lastHeartbeatMs: 0,
    lastSeq: 0,
    activeSessionId: null,
    sessionStartMs: 0,
    dailyMs: 0,
    dailyDate: todayStr(),
    ipHashes: [],
    fpHashes: [],
    concurrentHits: 0,
    cappedDays: 0,
    renameCount: 0,
    renameWindowStart: 0,
    flags: []
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (u[k] === undefined) { u[k] = v; dirty = true }
  }
  // fold legacy single ipHash into ipHashes
  if (u.ipHash && !u.ipHashes.includes(u.ipHash)) {
    u.ipHashes.push(u.ipHash)
    delete u.ipHash
    dirty = true
  }
  // reset daily counter on day rollover
  const today = todayStr()
  if (u.dailyDate !== today) {
    u.dailyDate = today
    u.dailyMs = 0
    dirty = true
  }
  return { user: u, dirty }
}

function withUser(id, fn) {
  const db = load()
  const raw = db.users[id]
  if (!raw) return null
  const { user, dirty } = migrate(raw)
  const out = fn(user, db)
  if (dirty || out?.save !== false) save(db)
  return out?.result ?? user
}

export function getUserById(id) {
  const db = load()
  const raw = db.users[id]
  if (!raw) return null
  const { user, dirty } = migrate(raw)
  if (dirty) { db.users[id] = user; save(db) }
  return user
}

export function getUserByNickname(nickname) {
  const db = load()
  const lower = nickname.toLowerCase()
  for (const raw of Object.values(db.users)) {
    const { user } = migrate(raw)
    if (user.nickname.toLowerCase() === lower) return user
  }
  return null
}

export function createUser(id, nickname, ipHash, fpHash) {
  const db = load()
  const now = new Date().toISOString()
  db.users[id] = {
    id,
    nickname,
    totalMs: 0,
    createdAt: now,
    lastSeen: now,
    lastHeartbeatMs: 0,
    lastSeq: 0,
    activeSessionId: null,
    sessionStartMs: 0,
    dailyMs: 0,
    dailyDate: todayStr(),
    ipHashes: ipHash ? [ipHash] : [],
    fpHashes: fpHash ? [fpHash] : [],
    concurrentHits: 0,
    cappedDays: 0,
    renameCount: 0,
    renameWindowStart: 0,
    flags: []
  }
  save(db)
  return db.users[id]
}

/** Count nicknames created from an ipHash today (sybil signal). */
export function countNicksByIpToday(ipHash) {
  const db = load()
  const today = new Date().toISOString().slice(0, 10)
  let n = 0
  for (const u of Object.values(db.users)) {
    if (u.createdAt?.slice(0, 10) === today && (u.ipHashes?.includes(ipHash) || u.ipHash === ipHash)) n++
  }
  return n
}

/** Count distinct userIds bound to a fingerprint (multi-account signal). */
export function countIdsByFp(fpHash) {
  if (!fpHash) return 0
  const db = load()
  let n = 0
  for (const u of Object.values(db.users)) {
    if (u.fpHashes?.includes(fpHash)) n++
  }
  return n
}

export function touchSeen(id) {
  return withUser(id, (user) => {
    user.lastSeen = new Date().toISOString()
    return { result: user }
  })
}

export function addFlag(id, flag) {
  return withUser(id, (user) => {
    if (!user.flags.includes(flag)) user.flags.push(flag)
    return { result: user }
  })
}

/**
 * Credit server-computed delta to a user. Returns updated user.
 * Handles daily rollover + daily cap accounting.
 */
export function creditTime(id, deltaMs, { sessionId, ipHash, fpHash, dailyCapMs }) {
  return withUser(id, (user) => {
    // roll daily counter
    const today = todayStr()
    if (user.dailyDate !== today) {
      user.dailyDate = today
      user.dailyMs = 0
    }
    // bind session / network identity
    user.activeSessionId = sessionId
    user.lastHeartbeatMs = Date.now()
    user.lastSeen = new Date().toISOString()
    if (ipHash && !user.ipHashes.includes(ipHash)) user.ipHashes.push(ipHash)
    if (fpHash && !user.fpHashes.includes(fpHash)) user.fpHashes.push(fpHash)

    // apply daily cap
    let credited = deltaMs
    let capped = false
    if (user.dailyMs + deltaMs >= dailyCapMs) {
      credited = Math.max(0, dailyCapMs - user.dailyMs)
      capped = true
      user.cappedDays += 1
      if (!user.flags.includes('daily-cap')) user.flags.push('daily-cap')
    }
    user.dailyMs += credited
    user.totalMs += credited
    return { result: { user, credited, capped } }
  })
}

export function setSession(id, sessionId) {
  return withUser(id, (user) => {
    user.activeSessionId = sessionId
    user.sessionStartMs = Date.now()
    user.lastHeartbeatMs = Date.now()
    user.lastSeen = new Date().toISOString()
    return { result: user }
  })
}

export function bumpSeq(id, seq) {
  return withUser(id, (user) => {
    user.lastSeq = seq
    return { result: user }
  })
}

export function bumpConcurrent(id) {
  return withUser(id, (user) => {
    user.concurrentHits += 1
    if (user.concurrentHits >= 3 && !user.flags.includes('concurrent')) user.flags.push('concurrent')
    return { result: user }
  })
}

/** Rename quota status (rolling 24h window). No writes. */
export function getRenameStatus(id) {
  const user = getUserById(id)
  if (!user) return null
  const now = Date.now()
  if (!user.renameWindowStart || now - user.renameWindowStart >= RENAME_WINDOW_MS) {
    return { remaining: RENAME_LIMIT, resetAtMs: 0 }
  }
  return {
    remaining: Math.max(0, RENAME_LIMIT - (user.renameCount || 0)),
    resetAtMs: user.renameWindowStart + RENAME_WINDOW_MS
  }
}

/**
 * Rename preserving all stats. Quota consumed ONLY on success —
 * taken names, same-name no-ops and unknown users never count.
 * Returns { user, old, remaining, resetAtMs } or { error, resetAtMs? }.
 */
export function renameUser(id, newNickname, { ipHash, fpHash }) {
  const db = load()
  const raw = db.users[id]
  if (!raw) return { error: 'unknown' }
  const { user } = migrate(raw)
  const now = Date.now()

  // roll the window
  if (!user.renameWindowStart || now - user.renameWindowStart >= RENAME_WINDOW_MS) {
    user.renameWindowStart = now
    user.renameCount = 0
  }

  // uniqueness (case-insensitive) — checked BEFORE consuming quota
  const lower = newNickname.toLowerCase()
  for (const other of Object.values(db.users)) {
    if (other.id !== id && other.nickname?.toLowerCase() === lower) {
      db.users[id] = user
      save(db)
      return { error: 'taken' }
    }
  }

  if ((user.renameCount || 0) >= RENAME_LIMIT) {
    db.users[id] = user
    save(db)
    return { error: 'limited', resetAtMs: user.renameWindowStart + RENAME_WINDOW_MS }
  }

  const old = user.nickname
  user.nickname = newNickname
  user.renameCount = (user.renameCount || 0) + 1
  user.lastSeen = new Date().toISOString()
  if (ipHash && !user.ipHashes.includes(ipHash)) user.ipHashes.push(ipHash)
  if (fpHash && !user.fpHashes.includes(fpHash)) user.fpHashes.push(fpHash)
  db.users[id] = user
  save(db)
  audit({ kind: 'rename', userId: id, from: old, to: newNickname, ip: ipHash, fp: fpHash })
  return {
    user,
    old,
    remaining: Math.max(0, RENAME_LIMIT - user.renameCount),
    resetAtMs: user.renameWindowStart + RENAME_WINDOW_MS
  }
}

/** Append-only audit trail for post-hoc cheat review (rotated past AUDIT_MAX_BYTES). */
export function audit(entry) {
  try {
    const st = statSync(AUDIT_FILE)
    if (st.size > AUDIT_MAX_BYTES) {
      try { renameSync(AUDIT_FILE, AUDIT_FILE + '.1') } catch { /* keep appending */ }
    }
  } catch { /* file may not exist yet — nothing to rotate */ }
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* best effort */ }
}

/** Test-only escape hatch: wipe users + audit log. Refuses outside NODE_ENV=test. */
export function __testWipe() {
  if (process.env.NODE_ENV !== 'test') throw new Error('test only')
  save({ users: {} })
  try { unlinkSync(AUDIT_FILE) } catch { /* ignore */ }
  try { unlinkSync(AUDIT_FILE + '.1') } catch { /* ignore */ }
}

export function getLeaderboard(limit = 50) {
  const db = load()
  const now = Date.now()
  return Object.values(db.users)
    .map(raw => migrate(raw).user)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
    .map(u => ({
      id: u.id,
      nickname: u.nickname,
      totalMs: u.totalMs,
      // online if heartbeat within last 20s
      online: now - (u.lastHeartbeatMs || 0) < 20000
    }))
}

export function getRank(id) {
  const db = load()
  const sorted = Object.values(db.users)
    .map(raw => migrate(raw).user)
    .sort((a, b) => b.totalMs - a.totalMs)
  const idx = sorted.findIndex(u => u.id === id)
  return idx === -1 ? null : idx + 1
}

/** Users worth a human look: flags, many IPs/fps, big totals. */
export function getFlagged() {
  const db = load()
  return Object.values(db.users)
    .map(raw => migrate(raw).user)
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
