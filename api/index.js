// Vercel serverless entry — every /api/* request lands here (see vercel.json).
// The Express app is imported, not listened on; Vercel invokes it per request.
// Requires env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ADMIN_TOKEN.
import { app } from '../server/index.js'

export default app
