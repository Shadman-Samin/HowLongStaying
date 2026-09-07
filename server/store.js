// Store selector: Redis (Upstash) when a REST URL is set, otherwise the
// local JSON file. Both modules expose the same interface, so the rest of
// the server never knows which backend is live.
//
// Accepts Vercel's KV_* aliases too (the Upstash integration injects
// KV_REST_API_URL / KV_REST_API_TOKEN, not UPSTASH_* names) — they are
// normalized before store-redis.js calls Redis.fromEnv().
if (!process.env.UPSTASH_REDIS_REST_URL && process.env.KV_REST_API_URL) {
  process.env.UPSTASH_REDIS_REST_URL = process.env.KV_REST_API_URL
}
if (!process.env.UPSTASH_REDIS_REST_TOKEN &&
    (process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN)) {
  process.env.UPSTASH_REDIS_REST_TOKEN =
    process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN
}

const mod = process.env.UPSTASH_REDIS_REST_URL
  ? await import('./store-redis.js')
  : await import('./store-json.js')

export const {
  addFlag,
  audit,
  bumpConcurrent,
  bumpSeq,
  consumeNonce,
  countIdsByFp,
  countNicksByIpToday,
  createUser,
  creditTime,
  getFlagged,
  getLeaderboard,
  getRank,
  getRenameStatus,
  getUserById,
  getUserByNickname,
  ipAllowed,
  issueNonce,
  renameUser,
  setSession,
  touchSeen,
  todayStr,
  __resetEphemeral,
  __testWipe
} = mod

export const STORE = process.env.UPSTASH_REDIS_REST_URL ? 'redis' : 'json'
