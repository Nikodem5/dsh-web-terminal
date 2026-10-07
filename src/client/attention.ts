// dsh-web-terminal — activity and attention: derives what each terminal is doing,
// decides when it needs the user, and raises the badge and desktop notification.

import { emit, focusWin, prefs, runtimes, store } from './state.ts'
import { displayName } from './names.ts'
import type { Activity, Runtime, WinState } from './types.ts'

/** A window is "unattended" when the user cannot currently see/notice it. */
let viewMounts = 0
export function setViewMounted(mounted: boolean): void {
  viewMounts = Math.max(0, viewMounts + (mounted ? 1 : -1))
}
function unattended(id: string): boolean {
  if (typeof document === 'undefined') return true
  return !(document.hasFocus() && viewMounts > 0 && store.focusId === id)
}

function notify(win: WinState, rt: Runtime, body: string): void {
  if (!prefs.notify || typeof Notification === 'undefined') return
  // Only interrupt when the app is in the background or the Terminals tab is not on screen.
  if (document.hasFocus() && viewMounts > 0) return
  try {
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
    if (Notification.permission !== 'granted') return
    const n = new Notification(displayName(win), { body, tag: `wt-${rt.id}` })
    n.onclick = () => {
      window.focus()
      focusWin(rt.id)
    }
  } catch {}
}

export function raiseAttention(rt: Runtime, reason: string): void {
  const win = store.wins.find((w) => w.id === rt.id)
  if (win === undefined || !unattended(rt.id)) return
  rt.attention = true
  rt.attentionReason = reason
  notify(win, rt, reason)
}

const WORK_QUIET_MS = 2500
const ECHO_GUARD_MS = 450
const MIN_WORK_MS = 3000

/** Derive the activity of one runtime from output recency, title glyph and host busy flag. */
function computeActivity(rt: Runtime, now: number): Activity {
  if (rt.conn === 'exited') return 'exited'
  if (rt.conn !== 'live') return 'offline'
  const spinning = /^[⠀-⣿]/.test(rt.title)
  const recentOutput = now - rt.lastOutputAt < WORK_QUIET_MS && now - rt.lastInputAt > ECHO_GUARD_MS
  if (spinning || recentOutput) return 'working'
  if (rt.hostBusy === true || rt.title.startsWith('✳')) return 'waiting'
  return 'idle'
}

export function tick(): void {
  const now = Date.now()
  let changed = false
  for (const rt of runtimes.values()) {
    const next = computeActivity(rt, now)
    if (next === rt.activity) continue
    const prev = rt.activity
    rt.activity = next
    changed = true
    if (next === 'working') rt.workStart = now
    else if (prev === 'working' && now - rt.workStart >= MIN_WORK_MS) {
      raiseAttention(rt, next === 'exited' ? 'The process exited' : next === 'waiting' ? 'Finished — waiting for you' : 'Finished')
    } else if (next === 'exited' && prev !== 'exited') {
      raiseAttention(rt, 'The process exited')
    }
  }
  if (changed) emit()
}
