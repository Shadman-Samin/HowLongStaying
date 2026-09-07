// Store selector: Redis (Upstash) when UPSTASH_REDIS_REST_URL is set,
// otherwise the local JSON file. Both modules expose the same interface,
// so the rest of the server never knows which backend is live.
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
