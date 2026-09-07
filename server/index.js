import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createHash, randomUUID, timingSafeEqual, createHmac } from 'crypto'
import {
  STORE,
  addFlag, audit, bumpConcurrent, consumeNonce, countIdsByFp, countNicksByIpToday,
  createUser, creditTick, deleteUser, getFlagged, getLeaderboard, getRank, getRenameStatus,
  getUserById, ipAllowed, issueNonce, renameUser, setSession, touchSeen,
  __resetEphemeral, __testWipe
} from './store.js'
import {
  HEARTBEAT_EXPECT_MS, MAX_CREDIT_MS, MIN_TICK_MS,
  DAILY_CAP_MS, SESSION_CAP_MS, NONCE_TTL_MS, MAX_NICKS_PER_IP_PER_DAY,
  MAX_IDS_PER_FP, ONLINE_MS, RENAME_LIMIT, IDLE_ATTEST_MS, UUID_RE, publicIdFor
} from './config.js'

const app = express()
const PORT = process.env.PORT || 3001

// ---- secrets: no usable default in production or on Vercel ----
const ADMIN_TOKEN = process.env.ADMIN_TOKEN
if (!ADMIN_TOKEN) {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    throw new Error('[HowLongStaying] ADMIN_TOKEN env is required in production — refusing to start')
  }
  console.log('[HowLongStaying] WARNING: using default ADMIN_TOKEN — set ADMIN_TOKEN env in production')
}
const ADMIN = ADMIN_TOKEN || 'dev-admin-token'
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN
console.log(`[HowLongStaying] store: ${STORE}`)

// Vercel terminates TLS at its edge and appends the real client IP.
// Trust exactly one proxy hop so req.ip is the client, not a spoofed header.
app.set('trust proxy', 1)

// ---- hardening middleware ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}))
const ALLOWED_ORIGINS = new Set([
  'https://howlongstaying.vercel.app',
  'http://localhost:5174',
  'http://localhost:3001'
])
app.use(cors({
  origin: (origin, cb) => {
    // no Origin header (curl, health checks, same-origin navigations) → allow
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true)
    return cb(new Error('CORS blocked'))
  },
  methods: ['GET', 'POST', 'DELETE']
}))
app.use(express.json({ limit: '10kb' }))

// rate limits (disabled under test so the suite can exercise guards directly)
const skipInTest = () => process.env.NODE_ENV === 'test'
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTest })
const challengeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTest })
const joinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTest })
const renameLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTest })
const adminLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, skip: skipInTest })
app.use('/api/', apiLimiter)

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
  // req.ip is proxy-aware (see trust proxy above); fall back to raw headers locally
  const ip = req.ip
    || req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown'
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

const validId = v => typeof v === 'string' && UUID_RE.test(v)
const validSeq = v => Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER
const clampLimit = v => Math.min(Math.max(parseInt(v) || 50, 1), 100)

// ---- session tokens: HMAC(userId.sessionId), unguessable without the secret ----
function sessionTokenFor(userId, sessionId) {
  return createHmac('sha256', SESSION_SECRET).update(`${userId}.${sessionId}`).digest('hex')
}

function providedToken(req) {
  return req.body?.sessionToken || req.headers['x-session-token'] || req.query.sessionToken
}

function tokenValid(provided, userId, sessionId) {
  if (typeof provided !== 'string' || !validId(userId) || !validId(sessionId)) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(sessionTokenFor(userId, sessionId))
  return a.length === b.length && timingSafeEqual(a, b)
}

function adminOk(req) {
  // header only — query-string tokens leak into access logs, CDN logs, history
  const h = req.headers['x-admin-token']
  if (typeof h !== 'string') return false
  const a = Buffer.from(h)
  const b = Buffer.from(ADMIN)
  return a.length === b.length && timingSafeEqual(a, b)
}

// 5s leaderboard cache — getLeaderboard is O(N); ticks no longer pay for rank
let boardCache = null // { ts, limit, data }
async function cachedBoard(limit) {
  const now = Date.now()
  if (boardCache && now - boardCache.ts < 5000 && boardCache.limit === limit) return boardCache.data
  const data = await getLeaderboard(limit)
  boardCache = { ts: now, limit, data }
  return data
}

// ================= ROUTES =================

// GET /api/challenge -> { nonce, expiresIn } — fetch before join/resume/rename
app.get('/api/challenge', challengeLimiter, async (_req, res) => {
  res.json({ nonce: await issueNonce(), expiresIn: Math.floor(NONCE_TTL_MS / 1000) })
})

// POST /api/join { nickname, userId?, fp?, nonce? }
app.post('/api/join', joinLimiter, async (req, res) => {
  const { nickname, userId, fp, nonce } = req.body || {}
  const ip = ipHash(req)
  const fpHash = sanitizeHash(fp)

  // returning user — resume identity, rotate session (challenge required, like new joins)
  if (userId) {
    if (!validId(userId)) return res.status(400).json({ error: 'Bad userId', code: 'BAD_REQ' })
    const existing = await getUserById(userId)
    if (existing) {
      if (!(await consumeNonce(nonce))) {
        return res.status(403).json({ error: 'Stale session — fetch a fresh challenge and retry', code: 'BAD_NONCE' })
      }
      const sessionId = randomUUID()
      await setSession(userId, sessionId)
      await audit({ kind: 'rejoin', userId, nick: existing.nickname, ip, fp: fpHash })
      return res.json({
        userId: existing.id,
        nickname: existing.nickname,
        totalMs: existing.totalMs,
        rank: await getRank(existing.id),
        sessionId,
        sessionToken: sessionTokenFor(userId, sessionId),
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

  const id = randomUUID()
  const sessionId = randomUUID()
  const created = await createUser(id, clean, ip, fpHash)
  if (created?.error === 'taken') {
    return res.status(409).json({ error: 'Nickname taken, pick another' })
  }
  await setSession(id, sessionId)
  await audit({ kind: 'join', userId: id, nick: clean, ip, fp: fpHash })
  res.json({
    userId: created.id, nickname: created.nickname, totalMs: 0,
    rank: await getRank(created.id), sessionId,
    sessionToken: sessionTokenFor(id, sessionId), seqStart: 0
  })
})

// POST /api/tick { userId, sessionId, sessionToken, seq, vis?, focus?, idleMs? }
// NOTE: client deltaMs is IGNORED — server computes time from its own clock.
app.post(['/api/tick', '/api/heartbeat'], async (req, res) => {
  const { userId, sessionId, sessionToken, seq, vis, focus, idleMs } = req.body || {}
  const ip = ipHash(req)
  const fpHash = sanitizeHash(req.body?.fp)

  if (!validId(userId) || !validId(sessionId) || !validSeq(seq)) {
    return res.status(400).json({ error: 'userId, sessionId (UUID) and positive integer seq required', code: 'BAD_REQ' })
  }
  if (!tokenValid(sessionToken, userId, sessionId)) {
    await audit({ kind: 'tick-reject', reason: 'bad-token', userId, ip })
    return res.status(401).json({ error: 'Bad session token. Rejoin.', code: 'BAD_TOKEN' })
  }
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user. Rejoin.', code: 'UNKNOWN_USER' })

  // per-IP flood guard (before touching user state)
  if (!(await ipAllowed(ip))) {
    await audit({ kind: 'tick-reject', reason: 'ip-flood', userId, ip })
    return res.status(429).json({ error: 'Too many requests from this network', code: 'IP_FLOOD', totalMs: user.totalMs })
  }

  const now = Date.now()

  // concurrent session guard: another session ticking within ONLINE window.
  // NOTE: IP is intentionally NOT part of this guard — dynamic IPs (mobile
  // rotation, CGNAT, VPN reconnects) must not cost progress. Identity is
  // sessionId + HMAC sessionToken + increasing seq. New IPs are adopted in
  // creditTick() and kept in ipHashes[] for sybil review.
  const fresh = now - (user.lastHeartbeatMs || 0) < ONLINE_MS
  const sessionMismatch = user.activeSessionId && user.activeSessionId !== sessionId
  if (fresh && sessionMismatch) {
    await bumpConcurrent(userId)
    await audit({ kind: 'tick-reject', reason: 'concurrent', userId, sessionId, ip })
    return res.status(409).json({
      error: 'Another tab/device is tracking this account. Keep only ONE tab open.',
      code: 'CONCURRENT', totalMs: user.totalMs
    })
  }
  if (user.ipHashes.length > 0 && !user.ipHashes.includes(ip)) {
    await audit({ kind: 'tick-ip-change', userId, sessionId, ip })
  }

  // session cap: >4h contiguous needs a human click to resume
  if (user.sessionStartMs && now - user.sessionStartMs > SESSION_CAP_MS) {
    await addFlag(userId, 'session-cap')
    await audit({ kind: 'tick-reject', reason: 'session-cap', userId, ip })
    return res.status(403).json({
      error: 'Session cap (4h) reached — click Resume to keep staying.',
      code: 'SESSION_CAP', totalMs: user.totalMs
    })
  }

  // attestation is ENFORCED, not just logged: a client that admits the tab is
  // hidden, the window blurred, or itself idle gets no credit for this tick.
  if ((vis && vis !== 'visible') || focus === false || (typeof idleMs === 'number' && idleMs > IDLE_ATTEST_MS)) {
    await addFlag(userId, 'attestation-mismatch')
    await audit({ kind: 'tick-reject', reason: 'attest', userId, ip, vis, focus })
    return res.status(409).json({ error: 'Tab not active — no credit.', code: 'ATTEST', totalMs: user.totalMs })
  }

  // ---- atomic money op: replay + min-interval + delta + cap in one step ----
  const out = await creditTick(userId, {
    seq, sessionId, ipHash: ip, fpHash,
    heartbeatExpectMs: HEARTBEAT_EXPECT_MS, maxCreditMs: MAX_CREDIT_MS,
    minTickMs: MIN_TICK_MS, dailyCapMs: DAILY_CAP_MS
  })
  if (out.error === 'unknown') {
    return res.status(404).json({ error: 'Unknown user. Rejoin.', code: 'UNKNOWN_USER' })
  }
  if (out.error === 'replay') {
    await audit({ kind: 'tick-reject', reason: 'replay', userId, seq, ip })
    return res.status(409).json({ error: 'Stale tick (replay?)', code: 'REPLAY', totalMs: out.totalMs })
  }
  if (out.error === 'fast') {
    return res.status(429).json({ error: 'Too fast', code: 'TOO_FAST', totalMs: out.totalMs })
  }
  // NOTE: routine accepted ticks are NOT audit-logged (heartbeat volume would
  // burn the Redis free tier); rejects + lifecycle events are logged above.

  res.json({ totalMs: out.user.totalMs, credited: out.credited, capped: out.capped, dailyMs: out.user.dailyMs })
})

// POST /api/rename { userId, sessionToken, newNickname, fp?, nonce } — 4 per rolling 24h
app.post('/api/rename', renameLimiter, async (req, res) => {
  const { userId, sessionToken, newNickname, fp, nonce } = req.body || {}
  const ip = ipHash(req)
  const fpHash = sanitizeHash(fp)

  if (!validId(userId) || !(await consumeNonce(nonce))) {
    return res.status(403).json({ error: 'Need a fresh challenge to rename — retry', code: 'BAD_NONCE' })
  }
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user. Rejoin.', code: 'UNKNOWN_USER' })
  if (!tokenValid(sessionToken, userId, user.activeSessionId)) {
    return res.status(401).json({ error: 'Bad session token. Rejoin.', code: 'BAD_TOKEN' })
  }

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

// POST /api/resume { userId, sessionToken, nonce } — human click after SESSION_CAP
app.post('/api/resume', async (req, res) => {
  const { userId, sessionToken, nonce } = req.body || {}
  if (!validId(userId) || !(await consumeNonce(nonce))) {
    return res.status(403).json({ error: 'Need a fresh challenge to resume', code: 'BAD_NONCE' })
  }
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user. Rejoin.' })
  if (!tokenValid(sessionToken, userId, user.activeSessionId)) {
    return res.status(401).json({ error: 'Bad session token. Rejoin.', code: 'BAD_TOKEN' })
  }
  const sessionId = randomUUID()
  await setSession(userId, sessionId)
  await audit({ kind: 'resume', userId, ip: ipHash(req) })
  res.json({
    sessionId, sessionToken: sessionTokenFor(userId, sessionId),
    seqStart: user.lastSeq || 0, totalMs: user.totalMs, rank: await getRank(userId)
  })
})

// POST /api/leave { userId, sessionToken } — beacon on tab close (no time added)
app.post('/api/leave', async (req, res) => {
  const { userId, sessionToken } = req.body || {}
  if (validId(userId)) {
    const user = await getUserById(userId)
    if (user && tokenValid(sessionToken, userId, user.activeSessionId)) {
      await touchSeen(userId)
    }
  }
  res.json({ ok: true })
})

app.get('/api/leaderboard', async (req, res) => {
  res.json({ leaders: await cachedBoard(clampLimit(req.query.limit)) })
})

app.get('/api/me', async (req, res) => {
  const { userId } = req.query
  if (!validId(userId)) return res.status(404).json({ error: 'Unknown user' })
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user' })
  if (!tokenValid(providedToken(req), userId, user.activeSessionId)) {
    return res.status(401).json({ error: 'Bad session token. Rejoin.', code: 'BAD_TOKEN' })
  }
  const rename = await getRenameStatus(user.id)
  res.json({
    userId: user.id,
    publicId: publicIdFor(user.id),
    nickname: user.nickname,
    totalMs: user.totalMs,
    dailyMs: user.dailyMs,
    rank: await getRank(user.id),
    renameRemaining: rename.remaining,
    renameResetAtMs: rename.resetAtMs,
    leaders: await cachedBoard(50)
  })
})

// DELETE /api/me { userId, sessionToken } — GDPR purge: account + nickname freed
app.delete('/api/me', async (req, res) => {
  const { userId, sessionToken } = req.body || {}
  if (!validId(userId)) return res.status(404).json({ error: 'Unknown user' })
  const user = await getUserById(userId)
  if (!user) return res.status(404).json({ error: 'Unknown user' })
  if (!tokenValid(sessionToken, userId, user.activeSessionId)) {
    return res.status(401).json({ error: 'Bad session token.', code: 'BAD_TOKEN' })
  }
  await deleteUser(userId)
  await audit({ kind: 'delete', userId, nick: user.nickname })
  res.json({ ok: true })
})

// Admin: flagged accounts for manual review (header token only — never ?token=)
app.get('/api/admin/flags', adminLimiter, async (req, res) => {
  if (!adminOk(req)) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  res.json({ flagged: await getFlagged() })
})

app.get('/api/health', (_req, res) => res.json({ ok: true, store: STORE }))

// Test-only reset: clears nonces, IP buckets, users + audit log. Never registered in production.
if (process.env.NODE_ENV === 'test') {
  app.post('/api/__reset', async (_req, res) => {
    boardCache = null
    await __resetEphemeral()
    await __testWipe()
    res.json({ ok: true })
  })
}

// Fallback: unknown /api/* → JSON 404 (never HTML); SPA shell otherwise
// (local single-server mode; on Vercel the CDN serves dist).
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Unknown endpoint' })
  }
  if (req.method === 'GET' && existsSync(join(DIST, 'index.html'))) {
    return res.sendFile(join(DIST, 'index.html'))
  }
  res.status(404).json({ error: 'Not found' })
})

export { app }

// Local / VPS mode only: Vercel imports the app instead of listening.
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[HowLongStaying] API on http://localhost:${PORT}`)
  })
}
