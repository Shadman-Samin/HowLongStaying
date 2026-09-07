# ⏱️ HowLongStaying

**Track the users with most time staying.** Anonymous active-tab dwell leaderboard.

Time counts **ONLY** when:
- ✅ tab is visible (`document.visibilityState === 'visible'`)
- ✅ window is focused (`document.hasFocus()`)
- ✅ user not idle 60s+ (mouse / keys / scroll / touch)

Switch tabs, minimize, or go AFK → timer pauses instantly.

## Run locally

```powershell
# terminal 1 — backend (http://localhost:3001)
npm run server

# terminal 2 — frontend dev (http://localhost:5174)
npm run dev
```

Or production single-server:

```powershell
npm run build
npm start   # serves dist + API on :3001
```

## Deploy (Vercel + Upstash Redis)

Serverless has no persistent disk/memory, so production uses Redis.
Local dev/tests keep using the JSON file automatically.

**Store selection:** `server/store.js` picks Redis when `UPSTASH_REDIS_REST_URL`
is set, otherwise `server/data/db.json`. Same interface, same anti-cheat.
(`GET /api/health` reports the active store.)

1. **Redis:** Vercel dashboard → your project → Storage → add Upstash Redis
   (free tier). It auto-injects `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
   Or create one at upstash.com and paste the REST URL + token manually.
2. **Env:** add `ADMIN_TOKEN` (any long random string — admin flags endpoint).
3. **Deploy:** `vercel.json` builds the frontend (`npm run build` → `dist`,
   served by CDN) and routes `/api/*` to the Express app (`api/index.js`).
   Import the repo in Vercel (or `npx vercel` from this folder) — no extra config.

Notes:
- Nonces + per-IP rate buckets live in Redis too (single-use `GETDEL`,
  sorted-set sliding window) so they survive across serverless instances.
- Audit trail is a capped Redis list (1000 entries). Routine accepted
  heartbeats are NOT logged (free-tier volume); joins, renames, resumes
  and all rejects are.

## How it works

- `src/tracker.js` — 1s tick + 5s heartbeat, only when tab active. Idle detection 60s.
- `src/main.js` — join flow (nickname → userId in localStorage), timer UI, polling.
- `src/leaderboard.js` — live top-50 render, online dots.
- `server/index.js` — Express API: `GET /api/challenge`, `POST /api/join`, `POST /api/tick` (=heartbeat), `POST /api/rename` (4 per 24h, stats preserved), `POST /api/resume`, `POST /api/leave`, `GET /api/leaderboard`, `GET /api/me`, `DELETE /api/me` (GDPR purge).

## Auth model

- `POST /api/join` (new + rejoin, both need a fresh `nonce`) returns a
  `sessionToken = HMAC(SECRET, userId.sessionId)`. Every mutating/read-own
  call (`tick`, `rename`, `resume`, `leave`, `me`) must present it —
  knowledge of `userId` alone gets `401 BAD_TOKEN`.
- Leaderboard exposes only `publicId` (truncated hash); raw ids never leave
  the server, so enumeration can't hijack accounts.
- Admin: `GET /api/admin/flags` with header `x-admin-token` ONLY
  (`?token=` is rejected — query strings leak into logs).
- Env: `ADMIN_TOKEN` (required in production/Vercel — boot throws without
  it), `SESSION_SECRET` (optional, defaults to `ADMIN_TOKEN`),
  `UPSTASH_REDIS_REST_URL/TOKEN` (or Vercel `KV_REST_API_*` aliases).
- `server/db.js` — JSON file store (`server/data/db.json`). Swap for SQLite/Postgres later.
## Anti-cheat (Tier A+B)

Client `deltaMs` is **ignored** — the server computes time from its own clock.

| Attack | Defense |
|---|---|
| Forged `deltaMs=999999` | Server credits `min(now - lastTick, 6.5s)` only |
| `curl` spam loop | Per-user 1 tick/2.5s + per-IP 15 ticks/10s sliding window |
| Replay captured payload | Strictly-increasing `seq` per user; single-use challenge `nonce` on join/resume |
| 10 tabs, same account | Concurrent-session guard: 2nd session/IP within 20s → `409 CONCURRENT` |
| 100 nicknames, 1 person | Max 5 nicks/IP/day + max 3 accounts/device fingerprint |
| 24/7 bot | 16h/day hard cap + 4h session cap (human click to resume) |
| Tab hidden / minimized / AFK | Client pauses (visibility + focus + 60s idle); server logs attestation |
| Spoofed `vis/focus/idleMs` | Server REJECTS self-admitted inactive ticks (`409 ATTEST`, no credit) |
| Stolen/enumerated `userId` | HMAC session tokens required; leaderboard shows `publicId` only |
| Race double-credit / dup nick | Atomic Lua ops (tick/rename/create/IP window) on Redis; single critical section on JSON |
| Spoofed `X-Forwarded-For` | `trust proxy` + `req.ip`; strict UUID/integer/limit validation; `__proto__` keys rejected |

- Rate limits: global 1000/15min + `challenge` 30/10min, `join` 60/10min, `rename` 30/10min, `admin` 60/10min (per IP). Bodies capped at 10kb.
- Headers: helmet CSP + `X-Frame-Options DENY` + HSTS + nosniff (also in `vercel.json` for CDN static). CORS allowlist: production domain + localhost dev only.
- Audit trail: `server/data/audit.log.ndjson` (all ticks + rejects).
- Review flags: `GET /api/admin/flags?token=$ADMIN_TOKEN` (set `ADMIN_TOKEN` env in prod).
- Flow: `GET /api/challenge` → `POST /api/join {nickname, fp, nonce}` → `POST /api/tick {userId, sessionId, seq, ...}` every 5s → `POST /api/resume` after session cap.

## API quick test

```powershell
$j = Invoke-RestMethod http://localhost:3001/api/join -Method POST -ContentType "application/json" -Body '{"nickname":"tab_goblin"}'
Invoke-RestMethod http://localhost:3001/api/heartbeat -Method POST -ContentType "application/json" -Body (@{userId=$j.userId; deltaMs=5000} | ConvertTo-Json)
Invoke-RestMethod http://localhost:3001/api/leaderboard?limit=10
```

## Next (v2 ideas)

- Weekly seasons + all-time board
- `?challenge=` share links, stay streaks
- Supabase/Cloudflare D1 instead of JSON file for deploy
- CAPTCHA if >3 nicknames per IP/day
