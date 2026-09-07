// Single source of truth for anti-cheat tuning. Shared by server + tests.
export const HEARTBEAT_EXPECT_MS = 5000   // client tick interval
export const MAX_CREDIT_MS = 6500         // server never credits more than this per tick (interval + jitter)
export const MIN_TICK_MS = 2500           // per-user min interval between accepted ticks
export const IP_WINDOW_MS = 10_000
export const IP_MAX_TICKS = 15            // max ticks per IP per window (shared NAT headroom)
export const DAILY_CAP_MS = 16 * 3600 * 1000
export const SESSION_CAP_MS = 4 * 3600 * 1000
export const NONCE_TTL_MS = 60_000
export const MAX_NICKS_PER_IP_PER_DAY = 5
export const MAX_IDS_PER_FP = 3
export const ONLINE_MS = 20_000
export const RENAME_LIMIT = 4              // max renames per rolling window
export const RENAME_WINDOW_MS = 24 * 3600 * 1000
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024  // rotate audit log past this size
export const IDLE_ATTEST_MS = 60_000       // client idleMs above this gets flagged
