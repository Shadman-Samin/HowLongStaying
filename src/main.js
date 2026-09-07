import './style.css'
import { Tracker, formatDuration, formatDurationLong } from './tracker.js'
import { renderBoard } from './leaderboard.js'

const $ = id => document.getElementById(id)
const timerEl = $('timer'), statusDot = $('status-dot'), statusText = $('status-text')
const sessionLabel = $('session-label'), rankLabel = $('rank-label'), nickLabel = $('nick-label')
const joinCard = $('join-card'), joinForm = $('join-form'), nickInput = $('nick-input'), joinError = $('join-error')
const boardEl = $('board'), meRow = $('me-row'), onlineCount = $('online-count')
const changeNickBtn = $('change-nick'), shareBtn = $('share-btn'), pauseHint = $('pause-hint')
const warnBox = $('warn-box'), resumeBox = $('resume-box'), resumeBtn = $('resume-btn')
const cancelRenameBtn = $('cancel-rename'), renameHint = $('rename-hint'), joinTitle = $('join-title')

const api = {
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      const err = new Error(data.error || 'Request failed')
      err.code = data.code
      err.data = data
      throw err
    }
    return data
  },
  async get(path) {
    const r = await fetch(path)
    return r.json()
  }
}

/** Lightweight device fingerprint (non-identifying, hashed server-side). */
async function fingerprint() {
  const parts = [
    navigator.userAgent || '',
    navigator.platform || '',
    navigator.hardwareConcurrency || '',
    screen.width + 'x' + screen.height,
    Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  ].join('|')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}
let fpPromise = fingerprint().catch(() => null)

let userId = localStorage.getItem('hls_userId') || null
let nickname = localStorage.getItem('hls_nickname') || null
let sessionId = null
let seq = 0
let rank = null
let sessionCapped = false
let renameMode = false

const tracker = new Tracker({
  onTick: ({ totalMs, sessionMs, active }) => {
    timerEl.textContent = formatDuration(totalMs)
    sessionLabel.textContent = `This visit: ${formatDurationLong(sessionMs)}`
    document.title = `${formatDuration(totalMs)} — HowLongStaying`
    if (!sessionCapped) updateStatusUI(active)
  },
  onStatusChange: status => { if (!sessionCapped) updateStatusUI(status.active, status.reason) },
  onHeartbeat: async () => {
    if (!userId || !sessionId || sessionCapped) return
    seq += 1
    const mySeq = seq
    try {
      // NOTE: no deltaMs sent — server computes time from its own clock (anti-cheat).
      const data = await api.post('/api/tick', {
        userId,
        sessionId,
        seq: mySeq,
        fp: await fpPromise,
        vis: document.visibilityState,
        focus: document.hasFocus(),
        idleMs: tracker.getIdleMs()
      })
      tracker.setTotalMs(data.totalMs)
      rank = data.rank
      rankLabel.textContent = `Rank: #${rank ?? '—'}`
      if (data.capped) {
        meRow.textContent = `Daily cap reached (16h) — see you tomorrow 🌙 · total ${formatDurationLong(data.totalMs)}`
        meRow.classList.remove('hidden')
      } else {
        refreshMeRow(data.totalMs)
      }
      hideWarn()
    } catch (e) {
      if (e.code === 'REPLAY' || e.code === 'UNKNOWN_USER') {
        // seq desync or unknown — rejoin to rotate session + resync
        await rejoin()
      } else if (e.code === 'CONCURRENT') {
        showWarn('⚠️ ' + e.message)
      } else if (e.code === 'SESSION_CAP') {
        enterSessionCap(e.data?.totalMs)
      }
      // TOO_FAST / IP_FLOOD: just skip, next tick retries
      seq = Math.max(seq, e.data?.lastSeq ?? seq)
    }
  }
})

function updateStatusUI(active, reason) {
  if (!userId) {
    statusDot.className = 'inline-block w-3 h-3 rounded-full bg-slate-500'
    statusText.textContent = 'NOT TRACKING — ENTER NICKNAME'
    statusText.className = 'font-mono text-sm text-slate-400'
    pauseHint.classList.add('hidden')
    return
  }
  if (active) {
    statusDot.className = 'inline-block w-3 h-3 rounded-full dot-active'
    statusText.textContent = '● TRACKING — YOU ARE STAYING'
    statusText.className = 'font-mono text-sm text-emerald-300'
    pauseHint.classList.add('hidden')
  } else {
    statusDot.className = 'inline-block w-3 h-3 rounded-full dot-paused'
    const msg = reason === 'tab-hidden' ? '⏸ PAUSED — TAB HIDDEN (come back!)'
      : reason === 'window-blur' ? '⏸ PAUSED — WINDOW NOT FOCUSED'
      : reason === 'idle' ? `⏸ PAUSED — IDLE ${Math.round(tracker.IDLE_TIMEOUT / 1000)}s+ (move mouse)`
      : '⏸ PAUSED'
    statusText.textContent = msg
    statusText.className = 'font-mono text-sm text-amber-300'
    pauseHint.classList.remove('hidden')
  }
}

function showWarn(msg) {
  warnBox.textContent = msg
  warnBox.classList.remove('hidden')
}
function hideWarn() {
  warnBox.classList.add('hidden')
}

function enterSessionCap(totalMs) {
  sessionCapped = true
  if (typeof totalMs === 'number') tracker.setTotalMs(totalMs)
  timerEl.textContent = formatDuration(tracker.totalMs)
  statusDot.className = 'inline-block w-3 h-3 rounded-full dot-paused'
  statusText.textContent = '🛑 SESSION CAP — CLICK RESUME BELOW'
  statusText.className = 'font-mono text-sm text-amber-300'
  resumeBox.classList.remove('hidden')
}

resumeBtn.addEventListener('click', async () => {
  resumeBtn.textContent = 'checking…'
  try {
    const { nonce } = await api.get('/api/challenge')
    const data = await api.post('/api/resume', { userId, nonce })
    sessionId = data.sessionId
    seq = data.seqStart || 0
    sessionCapped = false
    resumeBox.classList.add('hidden')
    resumeBtn.textContent = "I'M STILL HERE →"
    tracker.lastActivity = Date.now() // resume requires presence; idle gate still applies
    updateStatusUI(true)
  } catch (e) {
    resumeBtn.textContent = "I'M STILL HERE →"
    showWarn('Resume failed: ' + e.message)
  }
})

function showJoin() {
  joinCard.classList.remove('hidden')
  changeNickBtn.classList.add('hidden')
  shareBtn.classList.add('hidden')
  nickLabel.textContent = '???'
}

function showPlaying() {
  renameMode = false
  joinTitle.textContent = 'Enter the arena'
  renameHint.classList.add('hidden')
  cancelRenameBtn.classList.add('hidden')
  joinCard.classList.add('hidden')
  changeNickBtn.classList.remove('hidden')
  shareBtn.classList.remove('hidden')
  nickLabel.textContent = nickname
}

function fmtResetIn(resetAtMs) {
  if (!resetAtMs) return 'resets daily'
  const mins = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 60000))
  return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
}

async function refreshRenameHint() {
  if (!userId) return
  try {
    const me = await api.get('/api/me?userId=' + encodeURIComponent(userId))
    const n = me.renameRemaining ?? 4
    renameHint.textContent = `${n} name change${n === 1 ? '' : 's'} left per 24h · ${fmtResetIn(me.renameResetAtMs)}`
    renameHint.classList.remove('hidden')
  } catch { /* backend down — hint stays hidden */ }
}

/** Open the join card in rename mode — nothing is wiped, timer keeps ticking. */
function enterRenameMode() {
  if (!userId) return
  renameMode = true
  hideWarn()
  joinError.classList.add('hidden')
  joinTitle.textContent = 'Change your name'
  nickInput.value = nickname || ''
  joinCard.classList.remove('hidden')
  cancelRenameBtn.classList.remove('hidden')
  refreshRenameHint()
  nickInput.focus()
  nickInput.select()
}

/** "Go back" — discard the rename, restore playing UI, no server call, no data loss. */
function cancelRename() {
  renameMode = false
  joinError.classList.add('hidden')
  showPlaying()
}

async function refreshBoard() {
  try {
    const data = await api.get('/api/leaderboard?limit=50')
    renderBoard(boardEl, data.leaders, userId)
    highlightSharedNick()
    const online = data.leaders.filter(l => l.online).length
    onlineCount.textContent = online ? `${online} online now` : ''
    if (userId) {
      const idx = data.leaders.findIndex(l => l.id === userId)
      if (idx >= 0) {
        rank = idx + 1
        rankLabel.textContent = `Rank: #${rank}`
        refreshMeRow(data.leaders[idx].totalMs)
      }
    }
  } catch { /* backend down — ignore, keep ticking locally */ }
}

function refreshMeRow(totalMs) {
  if (!userId || rank == null) return
  meRow.classList.remove('hidden')
  meRow.textContent = `#${rank} · ${nickname} · ${formatDurationLong(totalMs)} — keep staying!`
}

// deep-link highlight for ?r=nickname share links — pulses the row once
let sharedHighlighted = false
function highlightSharedNick() {
  if (sharedHighlighted) return
  const target = new URLSearchParams(location.search).get('r')
  if (!target) { sharedHighlighted = true; return }
  const row = boardEl.querySelector(`li[data-nick="${CSS.escape(target.toLowerCase())}"]`)
  if (!row) return // not on board yet — retry on next poll
  sharedHighlighted = true
  row.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row.classList.add('row-flash')
  setTimeout(() => row.classList.remove('row-flash'), 4500)
}

async function rejoin() {
  if (!userId) return
  try {
    const data = await api.post('/api/join', { nickname: '', userId, fp: await fpPromise })
    sessionId = data.sessionId
    seq = data.seqStart || 0
    tracker.setTotalMs(data.totalMs)
    rank = data.rank
    rankLabel.textContent = `Rank: #${rank ?? '—'}`
    hideWarn()
  } catch {
    localStorage.removeItem('hls_userId')
    userId = null
    sessionId = null
    showJoin()
  }
}

joinForm.addEventListener('submit', async e => {
  e.preventDefault()
  joinError.classList.add('hidden')
  const name = nickInput.value.trim()
  if (name.length < 2) {
    joinError.textContent = 'Nickname needs 2+ characters.'
    joinError.classList.remove('hidden')
    return
  }
  // ---- rename branch: same account, stats preserved, 4 per 24h ----
  if (renameMode && userId) {
    try {
      const { nonce } = await api.get('/api/challenge')
      const data = await api.post('/api/rename', { userId, newNickname: name, fp: await fpPromise, nonce })
      nickname = data.nickname
      localStorage.setItem('hls_nickname', nickname)
      showPlaying()
      updateStatusUI(true)
      refreshBoard()
      if (data.unchanged) {
        meRow.textContent = `That's already your name 😉 · ${formatDurationLong(tracker.totalMs)} and counting`
        meRow.classList.remove('hidden')
      }
    } catch (err) {
      joinError.textContent = err.message
      joinError.classList.remove('hidden')
      // keep the form open so the user can fix the name or Go back;
      // on quota hit, refresh the countdown from the server timestamp
      if (err.code === 'RENAME_LIMIT' && err.data) {
        renameHint.textContent = `0 name changes left per 24h · ${fmtResetIn(err.data.resetAtMs)}`
        renameHint.classList.remove('hidden')
      }
    }
    return
  }
  // ---- fresh join branch (new account) ----
  try {
    const { nonce } = await api.get('/api/challenge')
    const data = await api.post('/api/join', { nickname: name, userId, fp: await fpPromise, nonce })
    userId = data.userId
    nickname = data.nickname
    sessionId = data.sessionId
    seq = data.seqStart || 0
    localStorage.setItem('hls_userId', userId)
    localStorage.setItem('hls_nickname', nickname)
    tracker.setTotalMs(data.totalMs)
    rank = data.rank
    rankLabel.textContent = `Rank: #${rank ?? '—'}`
    showPlaying()
    updateStatusUI(true)
    refreshBoard()
  } catch (err) {
    joinError.textContent = err.message
    joinError.classList.remove('hidden')
  }
})

changeNickBtn.addEventListener('click', enterRenameMode)

cancelRenameBtn.addEventListener('click', cancelRename)

// Esc backs out of rename mode too
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && renameMode) cancelRename()
})

shareBtn.addEventListener('click', async () => {
  const t = formatDurationLong(tracker.totalMs)
  const link = `${location.origin}${location.pathname}?r=${encodeURIComponent(nickname)}`
  const text = `I've stayed ${t} on HowLongStaying (rank #${rank ?? '?'}) — beat me if you can 👀 ${link}`
  try {
    await navigator.clipboard.writeText(text)
    shareBtn.textContent = 'copied ✓'
    setTimeout(() => (shareBtn.textContent = 'copy flex 📋'), 1500)
  } catch {
    prompt('Copy your flex:', text)
  }
})

// beacon on close — server just marks seen
window.addEventListener('pagehide', () => {
  if (!userId) return
  try {
    navigator.sendBeacon('/api/leave', JSON.stringify({ userId }))
  } catch { /* ignore */ }
})

// ---- boot ----
async function boot() {
  refreshBoard()
  setInterval(refreshBoard, 5000)

  if (userId) {
    try {
      const data = await api.post('/api/join', { nickname: '', userId, fp: await fpPromise })
      nickname = data.nickname
      sessionId = data.sessionId
      seq = data.seqStart || 0
      localStorage.setItem('hls_nickname', nickname)
      tracker.setTotalMs(data.totalMs)
      rank = data.rank
      rankLabel.textContent = `Rank: #${rank ?? '—'}`
      showPlaying()
    } catch {
      localStorage.removeItem('hls_userId')
      userId = null
      showJoin()
    }
  } else {
    showJoin()
  }
  tracker.start(tracker.totalMs)
  updateStatusUI(false)
}

boot()
