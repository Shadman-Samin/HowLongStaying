/**
 * Tracker — counts time ONLY when tab is active.
 * Conditions to count:
 *  - document.visibilityState === 'visible'
 *  - document.hasFocus() === true (window focused)
 *  - not idle (mouse/keyboard/scroll/touch within 60s)
 *  - page not hidden via Page Visibility API
 * Heartbeat sent to server every HEARTBEAT_MS only when active.
 */

export class Tracker {
  constructor({ onTick, onStatusChange, onHeartbeat }) {
    this.onTick = onTick
    this.onStatusChange = onStatusChange
    this.onHeartbeat = onHeartbeat

    this.totalMs = 0
    this.sessionMs = 0
    this.isActive = false
    this.isIdle = false
    this.lastActivity = Date.now()
    // touch devices have no mouse — give them a longer idle leash
    this.IDLE_TIMEOUT = ('ontouchstart' in window || navigator.maxTouchPoints > 0) ? 120_000 : 60_000
    this.HEARTBEAT_MS = 5000
    this.TICK_MS = 1000

    this._tickTimer = null
    this._heartbeatTimer = null
    this._idleCheckTimer = null
    this._started = false
    this._lastActiveCheck = true
  }

  start(initialTotalMs = 0) {
    if (this._started) return
    this._started = true
    this.totalMs = initialTotalMs
    this.sessionMs = 0
    this.lastActivity = Date.now()
    this._bindEvents()
    this._updateActiveState()
    this._tickTimer = setInterval(() => this._tick(), this.TICK_MS)
    this._heartbeatTimer = setInterval(() => this._maybeHeartbeat(), this.HEARTBEAT_MS)
    this._idleCheckTimer = setInterval(() => this._checkIdle(), 1000)
    // also listen for pagehide beacon
    window.addEventListener('pagehide', () => this._handlePageHide())
    document.addEventListener('visibilitychange', () => this._updateActiveState())
    window.addEventListener('focus', () => this._updateActiveState())
    window.addEventListener('blur', () => this._updateActiveState())
  }

  stop() {
    clearInterval(this._tickTimer)
    clearInterval(this._heartbeatTimer)
    clearInterval(this._idleCheckTimer)
    this._started = false
  }

  getStatus() {
    if (!this._started) return { active: false, reason: 'not-started' }
    if (document.visibilityState === 'hidden') return { active: false, reason: 'tab-hidden' }
    if (!document.hasFocus()) return { active: false, reason: 'window-blur' }
    if (this.isIdle) return { active: false, reason: 'idle' }
    return { active: true, reason: 'active' }
  }

  _bindEvents() {
    const resetIdle = () => {
      this.lastActivity = Date.now()
      if (this.isIdle) {
        this.isIdle = false
        this._updateActiveState()
      }
    }
    ;['mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach(ev => {
      window.addEventListener(ev, resetIdle, { passive: true })
    })
  }

  _checkIdle() {
    const idle = Date.now() - this.lastActivity > this.IDLE_TIMEOUT
    if (idle !== this.isIdle) {
      this.isIdle = idle
      this._updateActiveState()
    }
  }

  _updateActiveState() {
    const status = this.getStatus()
    const active = status.active
    if (active !== this._lastActiveCheck) {
      this._lastActiveCheck = active
      this.isActive = active
      this.onStatusChange?.(status)
    } else {
      this.isActive = active
      // still emit to keep UI in sync for reason changes
      this.onStatusChange?.(status)
    }
  }

  _tick() {
    this._updateActiveState()
    if (this.isActive) {
      this.totalMs += this.TICK_MS
      this.sessionMs += this.TICK_MS
      this.onTick?.({ totalMs: this.totalMs, sessionMs: this.sessionMs, active: true })
    } else {
      this.onTick?.({ totalMs: this.totalMs, sessionMs: this.sessionMs, active: false })
    }
  }

  _maybeHeartbeat() {
    if (!this.isActive) return
    // only send heartbeat when active — server validates delta
    this.onHeartbeat?.({ deltaMs: this.HEARTBEAT_MS })
  }

  _handlePageHide() {
    // best-effort beacon — caller should also handle
  }

  // for restoring from server
  setTotalMs(ms) {
    this.totalMs = ms
  }

  getIdleMs() {
    return Date.now() - this.lastActivity
  }
}

export function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatDurationLong(ms) {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts = []
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}
