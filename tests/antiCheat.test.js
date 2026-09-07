// Anti-cheat suite — codifies the manual attack simulations.
// Runs against the real Express app with an isolated store
// (POST /api/__reset clears users, nonces and IP buckets before each test).
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { app } from '../server/index.js'
import {
  MAX_CREDIT_MS, MIN_TICK_MS, MAX_NICKS_PER_IP_PER_DAY, RENAME_LIMIT
} from '../server/config.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
// comfortably above MIN_TICK_MS so legit ticks are accepted
const TICK_GAP = MIN_TICK_MS + 600

async function challenge() {
  const r = await request(app).get('/api/challenge')
  expect(r.status).toBe(200)
  return r.body.nonce
}

async function join(nickname, extra = {}) {
  const nonce = await challenge()
  return request(app).post('/api/join').send({ nickname, nonce, ...extra })
}

beforeEach(async () => {
  const r = await request(app).post('/api/__reset')
  expect(r.status).toBe(200)
})

describe('join challenge', () => {
  it('rejects join without nonce (403 BAD_NONCE)', async () => {
    const r = await request(app).post('/api/join').send({ nickname: 'no_nonce' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('BAD_NONCE')
  })

  it('rejects nonce reuse (403 BAD_NONCE)', async () => {
    const nonce = await challenge()
    const first = await request(app).post('/api/join').send({ nickname: 'first_come', nonce })
    expect(first.status).toBe(200)
    const second = await request(app).post('/api/join').send({ nickname: 'second_try', nonce })
    expect(second.status).toBe(403)
    expect(second.body.code).toBe('BAD_NONCE')
  })
})

describe('tick guards', () => {
  it('ignores forged client deltaMs — credits server-clock time only', async () => {
    const j = await join('honest_joe')
    await sleep(TICK_GAP)
    const t = await request(app).post('/api/tick').send({
      userId: j.body.userId, sessionId: j.body.sessionId, seq: 1, deltaMs: 999999
    })
    expect(t.status).toBe(200)
    expect(t.body.credited).toBeLessThanOrEqual(MAX_CREDIT_MS)
    expect(t.body.totalMs).toBeLessThan(10_000) // not 999999
  })

  it('rejects replayed seq (409 REPLAY)', async () => {
    const j = await join('replay_vic')
    await sleep(TICK_GAP)
    const base = { userId: j.body.userId, sessionId: j.body.sessionId, seq: 1 }
    const ok = await request(app).post('/api/tick').send(base)
    expect(ok.status).toBe(200)
    const replay = await request(app).post('/api/tick').send(base)
    expect(replay.status).toBe(409)
    expect(replay.body.code).toBe('REPLAY')
  })

  it('rejects back-to-back ticks (429 TOO_FAST)', async () => {
    const j = await join('speedy')
    await sleep(TICK_GAP)
    const first = await request(app).post('/api/tick').send({
      userId: j.body.userId, sessionId: j.body.sessionId, seq: 1
    })
    expect(first.status).toBe(200)
    const fast = await request(app).post('/api/tick').send({
      userId: j.body.userId, sessionId: j.body.sessionId, seq: 2
    })
    expect(fast.status).toBe(429)
    expect(fast.body.code).toBe('TOO_FAST')
  })

  it('rejects a second concurrent session (409 CONCURRENT)', async () => {
    const j = await join('two_tabs')
    await sleep(TICK_GAP)
    const first = await request(app).post('/api/tick').send({
      userId: j.body.userId, sessionId: j.body.sessionId, seq: 1
    })
    expect(first.status).toBe(200)
    const other = await request(app).post('/api/tick').send({
      userId: j.body.userId, sessionId: '00000000-0000-0000-0000-000000000000', seq: 2
    })
    expect(other.status).toBe(409)
    expect(other.body.code).toBe('CONCURRENT')
  })
})

describe('sybil limits', () => {
  it(`allows ${MAX_NICKS_PER_IP_PER_DAY} nicknames per IP per day, then 429`, async () => {
    for (let i = 0; i < MAX_NICKS_PER_IP_PER_DAY; i++) {
      const r = await join(`sybil_${i}`)
      expect(r.status).toBe(200)
    }
    const over = await join('sybil_over')
    expect(over.status).toBe(429)
  })
})

describe('rename quota', () => {
  it(`same-name is a free no-op, taken names don't count, then ${RENAME_LIMIT} renames and 429`, async () => {
    const alice = await join('alice_t')
    const bob = await join('bob_t')
    expect(alice.status).toBe(200)
    expect(bob.status).toBe(200)
    const uid = alice.body.userId

    const rename = (newNickname, nonce) =>
      request(app).post('/api/rename').send({ userId: uid, newNickname, nonce })

    // no nonce at all
    const naked = await request(app).post('/api/rename').send({ userId: uid, newNickname: 'x' })
    expect(naked.status).toBe(403)

    // same name — no-op, quota untouched
    const same = await rename('alice_t', await challenge())
    expect(same.status).toBe(200)
    expect(same.body.unchanged).toBe(true)
    expect(same.body.remaining).toBe(RENAME_LIMIT)

    // taken name — 409, quota untouched
    const taken = await rename('bob_t', await challenge())
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe('NICKNAME_TAKEN')

    // RENAME_LIMIT successful renames, stats preserved
    for (let i = 0; i < RENAME_LIMIT; i++) {
      const r = await rename(`alice_v${i}`, await challenge())
      expect(r.status).toBe(200)
      expect(r.body.remaining).toBe(RENAME_LIMIT - 1 - i)
      expect(r.body.totalMs).toBe(alice.body.totalMs)
    }

    // one more — locked out with a retry timestamp
    const over = await rename('alice_final', await challenge())
    expect(over.status).toBe(429)
    expect(over.body.code).toBe('RENAME_LIMIT')
    expect(over.body.resetAtMs).toBeGreaterThan(Date.now())

    // /api/me reports the quota
    const me = await request(app).get(`/api/me?userId=${uid}`)
    expect(me.body.nickname).toBe(`alice_v${RENAME_LIMIT - 1}`)
    expect(me.body.renameRemaining).toBe(0)
  }, 20_000)
})

describe('admin', () => {
  it('401 without token, 200 with token', async () => {
    const bad = await request(app).get('/api/admin/flags?token=wrong')
    expect(bad.status).toBe(401)
    const good = await request(app).get('/api/admin/flags?token=dev-admin-token')
    expect(good.status).toBe(200)
    expect(Array.isArray(good.body.flagged)).toBe(true)
  })
})
