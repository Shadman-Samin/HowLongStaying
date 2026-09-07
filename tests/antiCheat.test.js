// Anti-cheat + auth suite — codifies the manual attack simulations.
// Runs against the real Express app with an isolated store
// (POST /api/__reset clears users, nonces and IP buckets before each test).
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import { app } from '../server/index.js'
import {
  MAX_CREDIT_MS, MIN_TICK_MS, MAX_NICKS_PER_IP_PER_DAY, RENAME_LIMIT
} from '../server/config.js'
import { escapeHtml } from '../src/leaderboard.js'

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

function tick(sess, body = {}) {
  return request(app).post('/api/tick').send({
    userId: sess.userId,
    sessionId: sess.sessionId,
    sessionToken: sess.sessionToken,
    ...body
  })
}

function tickFromIp(sess, ip, body = {}) {
  return request(app).post('/api/tick').set('X-Forwarded-For', ip).send({
    userId: sess.userId,
    sessionId: sess.sessionId,
    sessionToken: sess.sessionToken,
    ...body
  })
}

function joinFromIp(nickname, ip, extra = {}) {
  return challenge().then(nonce =>
    request(app).post('/api/join').set('X-Forwarded-For', ip).send({ nickname, nonce, ...extra })
  )
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
    expect(first.body.sessionToken).toBeTruthy()
    const second = await request(app).post('/api/join').send({ nickname: 'second_try', nonce })
    expect(second.status).toBe(403)
    expect(second.body.code).toBe('BAD_NONCE')
  })

  it('rejoin with userId also requires a fresh nonce', async () => {
    const j = await join('rejoiner')
    const uid = j.body.userId
    const naked = await request(app).post('/api/join').send({ nickname: '', userId: uid })
    expect(naked.status).toBe(403)
    expect(naked.body.code).toBe('BAD_NONCE')
    const ok = await request(app).post('/api/join').send({ nickname: '', userId: uid, nonce: await challenge() })
    expect(ok.status).toBe(200)
    expect(ok.body.sessionToken).toBeTruthy()
  })

  it('rejects malformed userId (__proto__ pollution probe → 400)', async () => {
    const r = await request(app).post('/api/join').send({ nickname: '', userId: '__proto__', nonce: await challenge() })
    expect(r.status).toBe(400)
  })
})

describe('tick auth + guards', () => {
  it('rejects ticks without/invalid session token (401 BAD_TOKEN)', async () => {
    const j = await join('token_vic')
    const sess = j.body
    const naked = await request(app).post('/api/tick').send({ userId: sess.userId, sessionId: sess.sessionId, seq: 1 })
    expect(naked.status).toBe(401)
    expect(naked.body.code).toBe('BAD_TOKEN')
    const forged = await request(app).post('/api/tick').send({ userId: sess.userId, sessionId: sess.sessionId, sessionToken: '0'.repeat(64), seq: 1 })
    expect(forged.status).toBe(401)
  })

  it('leaderboard userIds are useless for hijack (publicId only, no id)', async () => {
    await join('listed')
    const board = await request(app).get('/api/leaderboard?limit=50')
    expect(board.status).toBe(200)
    expect(board.body.leaders.length).toBeGreaterThan(0)
    for (const l of board.body.leaders) {
      expect(l.publicId).toMatch(/^[0-9a-f]{12}$/)
      expect(l.id).toBeUndefined()
    }
    // knowing the publicId still can't tick (it's not a userId, token missing anyway)
    const spoof = await request(app).post('/api/tick').send({
      userId: board.body.leaders[0].publicId, sessionId: '00000000-0000-0000-0000-000000000000', seq: 1
    })
    expect([400, 401, 404]).toContain(spoof.status)
  })

  it('rejects non-integer / out-of-range seq (400)', async () => {
    const j = await join('seq_probe')
    for (const bad of [3.14, Infinity, -1, 0, '1']) {
      const r = await tick(j.body, { seq: bad })
      expect(r.status).toBe(400)
    }
  })

  it('ignores forged client deltaMs — credits server-clock time only', async () => {
    const j = await join('honest_joe')
    await sleep(TICK_GAP)
    const t = await tick(j.body, { seq: 1, deltaMs: 999999 })
    expect(t.status).toBe(200)
    expect(t.body.credited).toBeLessThanOrEqual(MAX_CREDIT_MS)
    expect(t.body.totalMs).toBeLessThan(10_000) // not 999999
  })

  it('rejects replayed seq (409 REPLAY)', async () => {
    const j = await join('replay_vic')
    await sleep(TICK_GAP)
    const ok = await tick(j.body, { seq: 1 })
    expect(ok.status).toBe(200)
    const replay = await tick(j.body, { seq: 1 })
    expect(replay.status).toBe(409)
    expect(replay.body.code).toBe('REPLAY')
  })

  it('rejects back-to-back ticks (429 TOO_FAST)', async () => {
    const j = await join('speedy')
    await sleep(TICK_GAP)
    const first = await tick(j.body, { seq: 1 })
    expect(first.status).toBe(200)
    const fast = await tick(j.body, { seq: 2 })
    expect(fast.status).toBe(429)
    expect(fast.body.code).toBe('TOO_FAST')
  })

  it('rejects a second concurrent session (409 CONCURRENT)', async () => {
    const j = await join('two_tabs')
    await sleep(TICK_GAP)
    const first = await tick(j.body, { seq: 1 })
    expect(first.status).toBe(200)
    const other = await tick(j.body, { sessionId: '00000000-0000-0000-0000-000000000000', seq: 2 })
    // token is bound to the claimed session → wrong-session token is rejected first
    expect([401, 409]).toContain(other.status)
  })

  it('keeps credit across dynamic IP change on same session (no CONCURRENT)', async () => {
    const j = await joinFromIp('dynamic_ip', '10.0.0.1')
    expect(j.status).toBe(200)
    const sess = j.body
    await sleep(TICK_GAP)
    const first = await tickFromIp(sess, '10.0.0.1', { seq: 1 })
    expect(first.status).toBe(200)
    await sleep(TICK_GAP)
    // ISP rotates IP, same tab/session/token/seq-chain → must still credit
    const rotated = await tickFromIp(sess, '10.0.0.2', { seq: 2 })
    expect(rotated.status).toBe(200)
    expect(rotated.body.code).toBeUndefined()
    expect(rotated.body.totalMs).toBeGreaterThan(first.body.totalMs)
    await sleep(TICK_GAP)
    const rotatedAgain = await tickFromIp(sess, '10.0.0.3', { seq: 3 })
    expect(rotatedAgain.status).toBe(200)
    expect(rotatedAgain.body.totalMs).toBeGreaterThan(rotated.body.totalMs)
  }, 20_000)

  it('still rejects stale session after rejoin (true concurrent, 409 CONCURRENT)', async () => {
    const j = await joinFromIp('two_tabs_ip', '10.0.0.1')
    expect(j.status).toBe(200)
    const oldSess = j.body
    await sleep(TICK_GAP)
    const first = await tickFromIp(oldSess, '10.0.0.1', { seq: 1 })
    expect(first.status).toBe(200)
    // second tab rejoins → rotates activeSessionId
    const rej = await request(app).post('/api/join')
      .set('X-Forwarded-For', '10.0.0.2')
      .send({ nickname: '', userId: oldSess.userId, nonce: await challenge() })
    expect(rej.status).toBe(200)
    // old tab ticks again with its (valid-for-old-session) token → CONCURRENT
    const stale = await tickFromIp(oldSess, '10.0.0.1', { seq: 2 })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('CONCURRENT')
  })

  it('rejects self-admitted inactive tabs (409 ATTEST, no credit)', async () => {
    const j = await join('hidden_tab')
    await sleep(TICK_GAP)
    const before = (await request(app).get(`/api/me?userId=${j.body.userId}&sessionToken=${j.body.sessionToken}`)).body.totalMs
    const hidden = await tick(j.body, { seq: 1, vis: 'hidden', focus: true, idleMs: 0 })
    expect(hidden.status).toBe(409)
    expect(hidden.body.code).toBe('ATTEST')
    const after = (await request(app).get(`/api/me?userId=${j.body.userId}&sessionToken=${j.body.sessionToken}`)).body.totalMs
    expect(after).toBe(before)
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
    const tok = alice.body.sessionToken

    const rename = (newNickname, nonce, token = tok) =>
      request(app).post('/api/rename').send({ userId: uid, sessionToken: token, newNickname, nonce })

    // no token at all
    const naked = await request(app).post('/api/rename').send({ userId: uid, newNickname: 'x', nonce: await challenge() })
    expect(naked.status).toBe(401)

    // wrong token
    const forged = await rename('x', await challenge(), '0'.repeat(64))
    expect(forged.status).toBe(401)

    // no nonce at all
    const noNonce = await request(app).post('/api/rename').send({ userId: uid, sessionToken: tok, newNickname: 'x' })
    expect(noNonce.status).toBe(403)

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

    // /api/me reports the quota (authed)
    const me = await request(app).get(`/api/me?userId=${uid}&sessionToken=${tok}`)
    expect(me.body.nickname).toBe(`alice_v${RENAME_LIMIT - 1}`)
    expect(me.body.renameRemaining).toBe(0)
    expect(me.body.publicId).toMatch(/^[0-9a-f]{12}$/)

    // /api/me without token — 401
    const meNaked = await request(app).get(`/api/me?userId=${uid}`)
    expect(meNaked.status).toBe(401)
  }, 20_000)
})

describe('gdpr purge', () => {
  it('DELETE /api/me removes the account and frees the nickname', async () => {
    const j = await join('deleteme')
    const uid = j.body.userId
    const tok = j.body.sessionToken
    const noAuth = await request(app).delete('/api/me').send({ userId: uid })
    expect(noAuth.status).toBe(401)
    const del = await request(app).delete('/api/me').send({ userId: uid, sessionToken: tok })
    expect(del.status).toBe(200)
    const me = await request(app).get(`/api/me?userId=${uid}&sessionToken=${tok}`)
    expect(me.status).toBe(404)
    // nickname is free again
    const rej = await join('deleteme')
    expect(rej.status).toBe(200)
  })
})

describe('input clamps', () => {
  it('clamps negative leaderboard limit to 1', async () => {
    await join('clamp_a')
    await join('clamp_b')
    const r = await request(app).get('/api/leaderboard?limit=-5')
    expect(r.status).toBe(200)
    expect(r.body.leaders.length).toBe(1)
  })
})

describe('xss escaping', () => {
  it('escapeHtml neutralizes tag-breaking payloads', () => {
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(escapeHtml(`a'b"c&d<e>`)).toBe('a&#39;b&quot;c&amp;d&lt;e&gt;')
  })
})

describe('admin', () => {
  it('401 without/wrong/query token, 200 with header token', async () => {
    const none = await request(app).get('/api/admin/flags')
    expect(none.status).toBe(401)
    const query = await request(app).get('/api/admin/flags?token=dev-admin-token')
    expect(query.status).toBe(401) // header only — query no longer accepted
    const wrong = await request(app).get('/api/admin/flags').set('x-admin-token', 'wrong')
    expect(wrong.status).toBe(401)
    const good = await request(app).get('/api/admin/flags').set('x-admin-token', 'dev-admin-token')
    expect(good.status).toBe(200)
    expect(Array.isArray(good.body.flagged)).toBe(true)
  })
})
