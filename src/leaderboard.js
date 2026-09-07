import { formatDurationLong } from './tracker.js'

export function medal(rank) {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return `<span class="text-slate-500 w-6 inline-block text-right">${rank}.</span>`
}

export function renderBoard(el, leaders, myPublicId) {
  if (!leaders.length) {
    el.innerHTML = '<li class="font-mono text-sm text-slate-500 py-6 text-center">no stayers yet — be the first 🫵</li>'
    return
  }
  el.innerHTML = leaders.map((u, i) => {
    const rank = i + 1
    const isMe = myPublicId && u.publicId === myPublicId
    return `<li data-nick="${escapeHtml(u.nickname.toLowerCase())}" class="flex items-center gap-3 rounded-xl px-4 py-2.5 font-mono text-sm border transition
      ${isMe ? 'border-cyan-400/60 bg-cyan-500/10 text-cyan-100' : 'border-slate-700/60 bg-slate-800/40 text-slate-200'}">
      <span class="w-8 text-center">${medal(rank)}</span>
      <span class="flex-1 truncate">${escapeHtml(u.nickname)} ${isMe ? '<span class="text-cyan-400 text-xs">(you)</span>' : ''}</span>
      <span class="text-slate-500 text-xs">${u.online ? '<span class="text-emerald-400">● online</span>' : '○ away'}</span>
      <span class="tabular-nums font-bold">${formatDurationLong(u.totalMs)}</span>
    </li>`
  }).join('')
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
