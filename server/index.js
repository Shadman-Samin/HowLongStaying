import express from 'express'
import cors from 'cors'
import { createHash, randomUUID } from 'crypto'
import {
  STORE,
  addFlag, audit, bumpConcurrent, bumpSeq, consumeNonce, countIdsByFp, countNicksByIpToday,
  createUser, creditTime, getFlagged, getLeaderboard, getRank, getRenameStatus, getUserById,
  getUserByNickname, ipAllowed, issueNonce, renameUser, setSession, touchSeen,
  __resetEphemeral, __testWipe
} from './store.js'
import {
  HEARTBEAT_EXPECT_MS, MAX_CREDIT_MS, MIN_TICK_MS,
  DAILY_CAP_MS, SESSION_CAP_MS, NONCE_TTL_MS, MAX_NICKS_PER_IP_PER_DAY,
  MAX_IDS_PER_FP, ONLINE_MS, RENAME_LIMIT, IDLE_ATTEST_MS
} from './config.js'

const app = express()
const PORT = process.env.PORT || 3001
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token'

if (!process.env.ADMIN_TOKEN) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[HowLongStaying] ADMIN_TOKEN env is required in production — refusing to start')
  }
  console.log('[HowLongStaying] WARNING: using default ADMIN_TOKEN — set ADMIN_TOKEN env in production')
}
console.log(`[HowLongStaying] store: ${STORE}`)

app.use(cors())
app.use(express.json())

// serve frontend dist in production (node server/index.js after vite build;
// on Vercel the CDN serves dist and only /api/* reaches this function)
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, '..', 'dist')
if (existsSync(DIST)) {
  app.use(express.static(DIST))
}

// ---- helpers ----
function ipHash(req) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
  return createHash('sha256').update(ip).digest('hex').slice(0, 16)
}

function sanitizeNickname(name) {
  if (typeof name !== 'string') return null
  const clean = name.trim().slice(0, 20)
  if (clean.length < 2) return null
  if (!/^[\w\- .]+$/i.test(clean)) return null
  return clean
}

function sanitizeHash(h) {
  if (typeof h !== 'string' || !/^[a-f0-9]{8,64}$/i.test(h)) return null
  return h.slice(0, 64)
}

// ================= ROUTES =================

// GET /api/challenge -> { nonce, expiresIn } — fetch before join/resume/rename
app.get('/api/challenge', async (_req, res) => {
  res.json({ nonce: await issueNonce(), expiresIn: Math.floor(NONCE_TTL_MS / 1000) })
})

// POST /api/join { nickname, userId?, fp?, nonce? }
app.post('/api/join', async (req, res) => {
  const { nickname, userId, fp, nonce } = req.body || {}
  const ip = ipHash(req)
  const fpHash = sanitizeHash(fp)

  // returning user — resume identity, rotate session
  if (userId) {
    const existing = await getUserById(userId)
    if (existing) {
      const sessionId = randomUUID()
      await setSession(userId, sessionId)
      await audit({ kind: 'rejoin', userId, nick: existing.nickname, ip, fp: fpHash })
      return res.json({
        userId: existing.id,
        nickname: existing.nickname,
        totalMs: existing.totalMs,
        rank: await getRank(existing.id),
        sessionId,
        seqStart: existing.lastSeq || 0
      })
    }
  }

  // new user — challenge required + sybil limits
  if (!(await consumeNonce(nonce))) {
    return res.status(403).json({ error: 'Stale session — fetch a fresh challenge and retry', code: 'BAD_NONCE' })
  }
  const clean = sanitizeNickname(nickname)
  if (!clean) {
    return res.status(400).json({ error: 'Nickname must be 2-20 chars (letters, numbers, space, - _ .)' })
  }
  if ((await countNicksByIpToday(ip)) >= MAX_NICKS_PER_IP_PER_DAY) {
    return res.status(429).json({ error: 'Too many nicknames from this network today. Try again tomorrow.' })
  }
  if (fpHash && (await countIdsByFp(fpHash)) >= MAX_IDS_PER_FP) {
    return res.status(429).json({ error: 'Too many accounts on this device. Stick to one legend.' })
  }
  const taken = await getUserByNickname(clean)
  if (taken) {
    return res.status(409).json({ error: 'Nickname taken, pick another' })
  }

  const id = randomUUID()
  const sessionId = randomUUID()
  const user = await createUser(id, clean, ip, fpHash)
  await setSession(id, sessionId)
  await audit({ kind: 'join', userId: id, nick: clean, ip, fp: fpHash })
  res.json({ userId: user.id, nickname: user.nickname, totalMs: 0, rank: await getRank(user.id), sessionId, seqStart: 0 })
})

// POST /api/tick { userId, sessionId, seq, vis?, focus?, idleMs? }
// NOTE: client deltaMs is IGNORED — server computes time from its own clock.
app.post(['/api/tick', '/api/heartbeat'], async (req, res) => {
  const { userId, sessionId, seq, vis, focus, idleMs } = req.body || {}
  const ip = ipHash(req)
  const fpHash = sanitizeHash(req.body?.fp)

  if (!userId || !sessionId || typeof seq !== 'number') {
    return res.status(400).json({ error: 'userId, sessionId and seq required', code: 'BAD_REQ' })
  }
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user. Rejoin.', code: 'UNKNOWN_USER' })

  // per-IP flood guard (before touching user state)
  if (!(await ipAllowed(ip))) {
    await audit({ kind: 'tick-reject', reason: 'ip-flood', userId, ip })
    return res.status(429).json({ error: 'Too many requests from this network', code: 'IP_FLOOD', totalMs: user.totalMs })
  }

  const now = Date.now()

  // replay guard: seq must strictly increase
  if (seq <= (user.lastSeq || 0)) {
    await audit({ kind: 'tick-reject', reason: 'replay', userId, seq, lastSeq: user.lastSeq, ip })
    return res.status(409).json({ error: 'Stale tick (replay?)', code: 'REPLAY', totalMs: user.totalMs, rank: await getRank(userId) })
  }

  // concurrent session guard: another session/ip ticking within ONLINE window
  const fresh = now - (user.lastHeartbeatMs || 0) < ONLINE_MS
  const sessionMismatch = user.activeSessionId && user.activeSessionId !== sessionId
  const ipChanged = user.ipHashes.length > 0 && !user.ipHashes.includes(ip)
  if (fresh && (sessionMismatch || ipChanged)) {
    await bumpConcurrent(userId)
    await audit({ kind: 'tick-reject', reason: 'concurrent', userId, sessionId, ip })
    return res.status(409).json({
      error: 'Another tab/device is tracking this account. Keep only ONE tab open.',
      code: 'CONCURRENT', totalMs: user.totalMs, rank: await getRank(userId)
    })
  }

  // per-user min interval (spam guard) — don't advance seq clock on reject
  if (user.lastHeartbeatMs && now - user.lastHeartbeatMs < MIN_TICK_MS) {
    return res.status(429).json({ error: 'Too fast', code: 'TOO_FAST', totalMs: user.totalMs, rank: await getRank(userId) })
  }

  // session cap: >4h contiguous needs a human click to resume
  if (user.sessionStartMs && now - user.sessionStartMs > SESSION_CAP_MS) {
    await addFlag(userId, 'session-cap')
    await audit({ kind: 'tick-reject', reason: 'session-cap', userId, ip })
    return res.status(403).json({
      error: 'Session cap (4h) reached — click Resume to keep staying.',
      code: 'SESSION_CAP', totalMs: user.totalMs, rank: await getRank(userId)
    })
  }

  // ---- authoritative delta: server clock only ----
  const elapsed = user.lastHeartbeatMs ? now - user.lastHeartbeatMs : HEARTBEAT_EXPECT_MS
  const delta = Math.max(0, Math.min(elapsed, MAX_CREDIT_MS))

  await bumpSeq(userId, seq)
  const { user: updated, credited, capped } = await creditTime(userId, delta, { sessionId, ipHash: ip, fpHash, dailyCapMs: DAILY_CAP_MS })

  // attestation mismatch logging (client claims active but signals say otherwise)
  if ((vis && vis !== 'visible') || focus === false || (typeof idleMs === 'number' && idleMs > IDLE_ATTEST_MS)) {
    await addFlag(userId, 'attestation-mismatch')
  }
  // NOTE: routine accepted ticks are NOT audit-logged (heartbeat volume would
  // burn the Redis free tier); rejects + lifecycle events are logged above.

  res.json({
    totalMs: updated.totalMs,
    credited,
    capped,
    dailyMs: updated.dailyMs,
    rank: await getRank(userId)
  })
})

// POST /api/rename { userId, newNickname, fp?, nonce } — 4 per rolling 24h, stats preserved
app.post('/api/rename', async (req, res) => {
  const { userId, newNickname, fp, nonce } = req.body || {}
  const ip = ipHash(req)
  const fpHash = sanitizeHash(fp)

  if (!userId || !(await consumeNonce(nonce))) {
    return res.status(403).json({ error: 'Need a fresh challenge to rename — retry', code: 'BAD_NONCE' })
  }
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user. Rejoin.', code: 'UNKNOWN_USER' })

  const clean = sanitizeNickname(newNickname)
  if (!clean) {
    return res.status(400).json({ error: 'Nickname must be 2-20 chars (letters, numbers, space, - _ .)', code: 'INVALID_NICKNAME' })
  }
  // same-name submit — no-op, no quota consumed
  if (clean.toLowerCase() === user.nickname.toLowerCase()) {
    const st = await getRenameStatus(userId)
    return res.json({ userId: user.id, nickname: user.nickname, unchanged: true, remaining: st.remaining, resetAtMs: st.resetAtMs })
  }

  const out = await renameUser(userId, clean, { ipHash: ip, fpHash })
  if (out.error === 'taken') {
    return res.status(409).json({ error: 'Nickname taken, pick another', code: 'NICKNAME_TAKEN' })
  }
  if (out.error === 'limited') {
    const mins = Math.max(1, Math.ceil((out.resetAtMs - Date.now()) / 60000))
    return res.status(429).json({
      error: `Name-change limit reached (${RENAME_LIMIT} per 24h). Try again in ${Math.floor(mins / 60)}h ${mins % 60}m.`,
      code: 'RENAME_LIMIT', remaining: 0, resetAtMs: out.resetAtMs
    })
  }
  if (out.error) return res.status(404).json({ error: 'Unknown user. Rejoin.', code: 'UNKNOWN_USER' })

  res.json({
    userId: out.user.id,
    nickname: out.user.nickname,
    totalMs: out.user.totalMs,
    rank: await getRank(out.user.id),
    remaining: out.remaining,
    resetAtMs: out.resetAtMs
  })
})

// POST /api/resume { userId, nonce } — human click after SESSION_CAP, rotates session
app.post('/api/resume', async (req, res) => {
  const { userId, nonce } = req.body || {}
  if (!userId || !(await consumeNonce(nonce))) {
    return res.status(403).json({ error: 'Need a fresh challenge to resume', code: 'BAD_NONCE' })
  }
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user. Rejoin.' })
  const sessionId = randomUUID()
  await setSession(userId, sessionId)
  await audit({ kind: 'resume', userId, ip: ipHash(req) })
  res.json({ sessionId, seqStart: user.lastSeq || 0, totalMs: user.totalMs, rank: await getRank(userId) })
})

// POST /api/leave { userId } — beacon on tab close (no time added)
app.post('/api/leave', async (req, res) => {
  const { userId } = req.body || {}
  if (userId) await touchSeen(userId)
  res.json({ ok: true })
})

app.get('/api/leaderboard', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100)
  res.json({ leaders: await getLeaderboard(limit) })
})

app.get('/api/me', async (req, res) => {
  const user = await getUserById(req.query.userId)
  if (!user) return res.status(404).json({ error: 'Unknown user' })
  const rename = await getRenameStatus(user.id)
  res.json({
    userId: user.id,
    nickname: user.nickname,
    totalMs: user.totalMs,
    dailyMs: user.dailyMs,
    rank: await getRank(user.id),
    renameRemaining: rename.remaining,
    renameResetAtMs: rename.resetAtMs,
    leaders: await getLeaderboard(50)
  })
})

// Admin: flagged accounts for manual review
app.get('/api/admin/flags', async (req, res) => {
  if (req.query.token !== ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  res.json({ flagged: await getFlagged() })
})

app.get('/api/health', (_req, res) => res.json({ ok: true, store: STORE }))

// Test-only reset: clears nonces, IP buckets, users + audit log. Never registered in production.
if (process.env.NODE_ENV === 'test') {
  app.post('/api/__reset', async (_req, res) => {
    await __resetEphemeral()
    await __testWipe()
    res.json({ ok: true })
  })
}

// SPA fallback (local single-server mode; on Vercel the CDN serves dist)
app.get('*', (_req, res) => {
  if (existsSync(join(DIST, 'index.html'))) {
    res.sendFile(join(DIST, 'index.html'))
  } else {
    res.status(404).json({ error: 'API only — run vite dev server for frontend' })
  }
})

export { app }

// Local / VPS mode only: Vercel imports the app instead of listening.
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[HowLongStaying] API on http://localhost:${PORT}`)
  })
}
