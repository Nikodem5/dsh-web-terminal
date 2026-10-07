// dsh-web-terminal — attention: what each terminal is doing and when it needs the user.
//
// The state of an agent comes only from its own signals (see lib/agent-signals.js on the
// host): working, needs-you, finished, failed, ended. Nothing is guessed from output.
// A terminal with no agent signals is a plain shell and shows only facts: running a
// program or not, exited, offline. The decision functions here are pure so they can be
// tested without a browser; the stateful half applies them to runtimes.

import { emit, focusWin, prefs, runtimes, store, updateWin } from './state.ts'
import { isSessionId } from './launch.ts'
import { displayName } from './names.ts'
import type { Activity, AgentInfo, AgentSignal, AgentState, AttentionLevel, Conn, Runtime, WinState } from './types.ts'

// ── pure decisions ─────────────────────────────────────────────────────────

/** What the status dot shows for one terminal. */
export function deriveActivity(input: { conn: Conn; agent: AgentInfo | undefined; hostBusy: boolean | undefined }): Activity {
  if (input.conn === 'exited') return 'exited'
  if (input.conn !== 'live') return 'offline'
  switch (input.agent?.state) {
    case 'working':
      return 'working'
    case 'needs-you':
    case 'failed':
      return 'needs-you'
    case 'finished':
      return 'finished'
    case 'idle':
      return 'idle'
    default:
      // No agent (or it ended): a plain shell, where the only facts are whether a program is running.
      return input.hostBusy === true ? 'running' : 'idle'
  }
}

/** A request for the user's eyes. `label` is the short badge text, `reason` the tooltip/notification body. */
export interface Alert {
  level: AttentionLevel
  label: string
  reason: string
}

/** Text after a colon, when there is any. */
const withDetail = (head: string, detail: string): string => (detail.length > 0 ? `${head}: ${detail}` : head)

/**
 * Whether a new agent signal should ask for the user.
 * Blocked or failed is urgent; a finished turn is quiet; everything else is silent.
 * A state that merely repeats the previous one never alerts again (Claude reports both a
 * permission request and a notification for one prompt, and an idle notice after a Stop).
 */
export function alertFor(prev: AgentState | undefined, next: AgentSignal): Alert | undefined {
  if (prev === next.state) return undefined
  switch (next.state) {
    case 'needs-you':
      return { level: 'urgent', label: 'needs you', reason: withDetail('Needs you', next.detail) }
    case 'failed':
      return { level: 'urgent', label: 'failed', reason: withDetail('Failed', next.detail) }
    case 'finished':
      return { level: 'quiet', label: 'finished', reason: 'Finished — waiting for your next prompt' }
    default:
      return undefined
  }
}

/** Alert for a shell that exited: urgent when an agent was mid-task or the exit code is non-zero. */
export function exitAlert(agentState: AgentState | undefined, exitCode: number | null | undefined): Alert {
  const interrupted = agentState === 'working' || agentState === 'needs-you'
  const failed = typeof exitCode === 'number' && exitCode !== 0
  return interrupted || failed
    ? { level: 'urgent', label: 'exited', reason: failed ? `The process exited with code ${exitCode}` : 'The process exited while the agent was working' }
    : { level: 'quiet', label: 'exited', reason: 'The process exited' }
}

/**
 * Alert for a terminal whose shell vanished with the host (the page stayed open). Urgent when an
 * agent was mid-task: that work is gone and nothing else will say so.
 */
export function hostRestartAlert(agentState: AgentState | undefined): Alert {
  const interrupted = agentState === 'working' || agentState === 'needs-you'
  return {
    level: interrupted ? 'urgent' : 'quiet',
    label: 'host restarted',
    reason: interrupted ? 'The host restarted and the agent was lost mid-task. Restart this window to resume' : 'The host restarted and this shell is gone. Restart this window',
  }
}

/** Alert for an agent that has been "working" with no output and no signal for too long, or undefined. */
export function hungAlert(agent: AgentInfo | undefined, lastOutputAt: number, now: number, minutes: number): Alert | undefined {
  if (agent?.state !== 'working' || minutes <= 0) return undefined
  const quietMs = now - Math.max(agent.since, lastOutputAt)
  return quietMs >= minutes * 60_000
    ? { level: 'urgent', label: 'stuck?', reason: `No output or activity for ${minutes} min — the agent may be stuck` }
    : undefined
}

// ── attention state ────────────────────────────────────────────────────────

/** A window is "unattended" when the user cannot currently see/notice it. */
let viewMounts = 0
export function setViewMounted(mounted: boolean): void {
  viewMounts = Math.max(0, viewMounts + (mounted ? 1 : -1))
}
function unattended(id: string): boolean {
  if (typeof document === 'undefined') return true
  return !(document.hasFocus() && viewMounts > 0 && store.focusId === id)
}

/** Short two-note chime for urgent alerts; best effort (browsers may block audio until the page was used). */
function chime(): void {
  try {
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
    if (Ctx === undefined) return
    const audio = new Ctx()
    const now = audio.currentTime
    for (const [i, hz] of [880, 660].entries()) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.frequency.value = hz
      gain.gain.setValueAtTime(0.0001, now + i * 0.16)
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.16 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.15)
      osc.connect(gain).connect(audio.destination)
      osc.start(now + i * 0.16)
      osc.stop(now + i * 0.16 + 0.16)
    }
    setTimeout(() => audio.close().catch(() => {}), 800)
  } catch {}
}

/**
 * Desktop notification. Urgent alerts interrupt whenever the user is not looking at the
 * Terminals tab; quiet ones only when the whole app is in the background.
 */
function notify(win: WinState, rt: Runtime, alert: Alert): void {
  if (!prefs.notify || typeof Notification === 'undefined') return
  const appFocused = document.hasFocus()
  if (alert.level === 'quiet' ? appFocused : appFocused && viewMounts > 0) return
  try {
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
    if (Notification.permission !== 'granted') return
    const n = new Notification(displayName(win), { body: alert.reason, tag: `wt-${rt.id}` })
    n.onclick = () => {
      window.focus()
      focusWin(rt.id)
    }
  } catch {}
}

/**
 * Mark a terminal as needing the user, unless they are already looking at it.
 * @param silent - badge only, no notification or sound (used when restoring state after a reload).
 */
export function raiseAttention(rt: Runtime, alert: Alert, silent = false): void {
  const win = store.wins.find((w) => w.id === rt.id)
  if (win === undefined || !unattended(rt.id)) return
  // A quiet alert never replaces an urgent one that is still unanswered.
  if (rt.attention && rt.attentionLevel === 'urgent' && alert.level === 'quiet') return
  rt.attention = true
  rt.attentionLevel = alert.level
  rt.attentionLabel = alert.label
  rt.attentionReason = alert.reason
  if (!silent) {
    notify(win, rt, alert)
    if (alert.level === 'urgent' && prefs.sound) chime()
  }
  emit()
}

/** Drop a terminal's attention flag. */
export function clearAttention(rt: Runtime): void {
  if (!rt.attention) return
  rt.attention = false
  rt.attentionLevel = null
  rt.attentionLabel = ''
  rt.attentionReason = ''
}

/** Recompute the status dot of one runtime. Returns true when it changed. */
function refreshActivity(rt: Runtime): boolean {
  const next = deriveActivity(rt)
  if (next === rt.activity) return false
  rt.activity = next
  return true
}

// ── applying signals ───────────────────────────────────────────────────────

/**
 * Remember the conversation id so a fresh shell can resume it. `idle` (session opened, nothing
 * said yet) is skipped: that conversation does not exist on disk, and resuming it would fail.
 */
function rememberSession(rt: Runtime, signal: AgentSignal): void {
  if (signal.state === 'idle' || signal.state === 'ended' || !isSessionId(signal.session)) return
  const win = store.wins.find((w) => w.id === rt.id)
  if (win !== undefined && win.agentSession !== signal.session) updateWin(rt.id, { agentSession: signal.session })
}

/** An agent reported a state. */
export function applyAgentSignal(rt: Runtime, signal: AgentSignal): void {
  const prev = rt.agent?.state
  rememberSession(rt, signal)
  rt.agent = { provider: signal.provider, state: signal.state, detail: signal.detail, since: signal.at ?? Date.now() }
  rt.hungRaised = false
  // A new turn, or the answer to a prompt, means whatever raised attention has been dealt with.
  if (signal.state === 'working') clearAttention(rt)
  const alert = alertFor(prev, signal)
  refreshActivity(rt)
  if (alert !== undefined) raiseAttention(rt, alert)
  // Always repaint: raiseAttention does nothing when the user is already looking at the terminal.
  emit()
}

/**
 * The host told a reattaching browser what state the agent is in. Adopt it, and show the
 * badge if the agent is waiting on the user, but do not make noise for something that
 * happened while the page was closed.
 */
export function restoreAgent(rt: Runtime, signal: AgentSignal | null | undefined): void {
  if (signal === null || signal === undefined) return
  rememberSession(rt, signal)
  rt.agent = { provider: signal.provider, state: signal.state, detail: signal.detail, since: signal.at ?? Date.now() }
  rt.hungRaised = false
  const alert = alertFor(undefined, signal)
  refreshActivity(rt)
  if (alert !== undefined) raiseAttention(rt, alert, true)
  emit()
}

/**
 * The user typed into a terminal whose agent was waiting on them: assume they answered.
 * The next signal corrects this if they did not (Claude has no event for "prompt answered").
 */
export function noteUserInput(rt: Runtime): void {
  if (rt.agent?.state !== 'needs-you') return
  rt.agent = { ...rt.agent, state: 'working', since: Date.now() }
  clearAttention(rt)
  refreshActivity(rt)
  emit()
}

/**
 * The host reports whether a program runs under the shell. When it stops while an agent was
 * still active, the agent died without saying goodbye (crash, kill).
 */
export function noteHostBusy(rt: Runtime, busy: boolean): void {
  rt.hostBusy = busy
  const state = rt.agent?.state
  if (!busy && rt.agent !== undefined && state !== 'ended') {
    rt.agent = { ...rt.agent, state: 'ended', detail: '', since: Date.now() }
    if (state === 'working' || state === 'needs-you') {
      raiseAttention(rt, { level: 'urgent', label: 'stopped', reason: 'The agent stopped without finishing' })
    }
  }
  refreshActivity(rt)
  emit()
}

/** The shell itself exited. */
export function noteExit(rt: Runtime, exitCode: number | null | undefined): void {
  const alert = exitAlert(rt.agent?.state, exitCode)
  refreshActivity(rt)
  raiseAttention(rt, alert)
  emit()
}

/** The host restarted under an open page and this terminal's shell is gone. */
export function noteHostRestart(rt: Runtime): void {
  const alert = hostRestartAlert(rt.agent?.state)
  refreshActivity(rt)
  raiseAttention(rt, alert)
  emit()
}

/** Once a second: refresh dots after connection changes and look for hung agents. */
export function tick(): void {
  const now = Date.now()
  let changed = false
  for (const rt of runtimes.values()) {
    if (refreshActivity(rt)) changed = true
    if (!rt.hungRaised) {
      const alert = hungAlert(rt.agent, rt.lastOutputAt, now, prefs.hungMinutes)
      if (alert !== undefined) {
        rt.hungRaised = true
        raiseAttention(rt, alert)
        changed = true
      }
    }
  }
  if (changed) emit()
}
