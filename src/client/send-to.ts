// dsh-web-terminal — send the selection of one terminal to another (or to a new Claude terminal).
//
// Right-click a selection (or Ctrl+Shift+S) opens a picker of the other terminals; the text lands in
// the target as a paste, without Enter, so the user adds context and submits. The pure parts (target
// order, text clean-up, framing, paste wrapping) are exported for tests.

import { emit, focusWin, persistSoon, prefs, runtimes, store } from './state.ts'
import { displayName } from './names.ts'
import { openTerminal } from './windows.ts'
import { isOverview } from './mission.ts'
import type { Activity, Runtime, WinState } from './types.ts'

/** Selections bigger than this ask before they are sent. */
export const MAX_SEND_CHARS = 32 * 1024

// ── pure parts ──

export interface TargetInfo {
  id: string
  name: string
  agent: boolean
  live: boolean
  activity: Activity
}

/** Whether a window runs an agent: one that reported (and has not ended), else one started as `claude`. */
export function isAgentTarget(startup: string | undefined, agent: { state: string } | undefined): boolean {
  if (agent !== undefined) return agent.state !== 'ended'
  return /^\s*claude(?=\s|$)/.test(startup ?? '')
}

/** Terminals that can receive a send: not the source, connected; agents first, otherwise in list order. */
export function orderTargets(all: TargetInfo[], sourceId: string): TargetInfo[] {
  const ok = all.filter((t) => t.id !== sourceId && t.live)
  return [...ok.filter((t) => t.agent), ...ok.filter((t) => !t.agent)]
}

/**
 * Selection text made safe to paste: LF newlines, no trailing spaces per line, no blank lines at either
 * end, and no control characters (an ESC could end a bracketed paste early or start a command sequence).
 */
export function cleanSelection(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

/** Quote the text as a code block, with a fence longer than any backtick run inside so it cannot close early. */
export function frameCodeBlock(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}\n`
}

/**
 * Bytes to write to the target. Bracketed paste wraps the text so the program takes it as one paste
 * (newlines as CR, like xterm's own paste). Without it the text is typed: CR between lines and none
 * after the last, so the send never presses Enter.
 */
export function pasteInput(text: string, bracketed: boolean): string {
  if (bracketed) return `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`
  return text.replace(/\n+$/, '').replace(/\n/g, '\r')
}

/** Whether a send needs the user's OK first. */
export function needsConfirm(text: string, bracketed: boolean): 'big' | 'lines' | null {
  if (text.length > MAX_SEND_CHARS) return 'big'
  // Typed into a program with no paste mode, every line but the last would be submitted.
  if (!bracketed && text.trim().includes('\n')) return 'lines'
  return null
}

// ── sending ──

function describe(win: WinState): TargetInfo {
  const rt = runtimes.get(win.id)
  return {
    id: win.id,
    name: displayName(win),
    agent: isAgentTarget(win.startup, rt?.agent),
    live: rt?.socket?.readyState === WebSocket.OPEN,
    activity: rt?.activity ?? 'offline',
  }
}

/** The terminals the picker offers for a selection made in `sourceId`. */
export function sendTargets(sourceId: string): TargetInfo[] {
  return orderTargets(store.wins.map(describe), sourceId)
}

/** Paste `selection` into a terminal and focus it (restoring it if minimized). Returns whether it was sent. */
export function sendSelection(selection: string, targetId: string): boolean {
  const rt = runtimes.get(targetId)
  const win = store.wins.find((w) => w.id === targetId)
  if (rt === undefined || win === undefined || rt.socket?.readyState !== WebSocket.OPEN) return false
  const clean = cleanSelection(selection)
  if (clean.length === 0) return false
  const bracketed = rt.term.modes.bracketedPasteMode
  const agent = isAgentTarget(win.startup, rt.agent)
  const text = agent && prefs.sendCodeBlock ? frameCodeBlock(clean) : clean
  const ask = needsConfirm(text, bracketed)
  if (ask === 'big' && !window.confirm(`Send ${Math.round(text.length / 1024)} KB of text to "${displayName(win)}"?`)) return false
  if (ask === 'lines' && !window.confirm(`"${displayName(win)}" has no paste mode, so each line is typed and may run. Send anyway?`)) return false
  rt.lastInputAt = Date.now()
  rt.socket.send(JSON.stringify({ type: 'input', data: pasteInput(text, bracketed) }))
  focusWin(targetId)
  return true
}

/** How long a fresh Claude gets to come up before the send is given up (the text is copied instead). */
export const NEW_CLAUDE_TIMEOUT_MS = 60_000
/** Output must have been quiet this long, after the `claude` command was typed, before the send. */
export const NEW_CLAUDE_SETTLE_MS = 800

/**
 * Open a Claude terminal beside the source (same folder and shell) and send once it is ready: its
 * startup command has been typed, its screen has gone quiet and it switched bracketed paste on (Claude
 * does so when its prompt is up; the shell's own paste mode was switched off to run the command).
 */
export function sendToNewClaude(selection: string, sourceId: string): void {
  const source = store.wins.find((w) => w.id === sourceId)
  const id = openTerminal({ cwd: source?.cwd, shell: source?.shell, startup: 'claude' })
  const started = Date.now()
  const timer = setInterval(() => {
    // The window's runtime appears when the view renders it; a closed window ends the wait.
    if (!store.wins.some((w) => w.id === id)) return clearInterval(timer)
    const rt = runtimes.get(id)
    if (rt === undefined) return
    const now = Date.now()
    if (now - started > NEW_CLAUDE_TIMEOUT_MS) {
      clearInterval(timer)
      navigator.clipboard?.writeText(selection).catch(() => {})
      return
    }
    if (!claudeReady(rt, now)) return
    clearInterval(timer)
    sendSelection(selection, id)
  }, 200)
}

function claudeReady(rt: Runtime, now: number): boolean {
  if (rt.startupSentAt === undefined || rt.socket?.readyState !== WebSocket.OPEN) return false
  return now - Math.max(rt.startupSentAt, rt.lastOutputAt) >= NEW_CLAUDE_SETTLE_MS && rt.term.modes.bracketedPasteMode
}

// ── the picker's state (one at a time, shared by the right-click and the shortcut) ──

export interface SendRequest {
  sourceId: string
  text: string
  /** Where to anchor the menu, in viewport pixels. */
  x: number
  y: number
}

let request: SendRequest | null = null
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((l) => l())

export const subscribeSend = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const getSendRequest = (): SendRequest | null => request

/** Open the picker for a terminal's current selection; false when there is nothing selected. */
export function openSendMenu(rt: Runtime, at?: { x: number; y: number }): boolean {
  // Not under the mission-control overview, whose windows are thumbnails.
  if (isOverview() || !rt.term.hasSelection()) return false
  const box = rt.holder.getBoundingClientRect()
  request = { sourceId: rt.id, text: rt.term.getSelection(), x: at?.x ?? box.left + box.width / 2 - 100, y: at?.y ?? box.top + 40 }
  notify()
  return true
}

export function closeSendMenu(): void {
  if (request === null) return
  request = null
  notify()
}

/**
 * Right-click on a selection opens the picker. With a program tracking the mouse the click belongs to
 * it, so there Shift+right-click (xterm's own "I want to select" override) is the way in.
 */
export function registerSendMenu(rt: Runtime): void {
  rt.holder.addEventListener(
    'contextmenu',
    (event) => {
      if (!rt.term.hasSelection()) return
      if (rt.term.modes.mouseTrackingMode !== 'none' && !event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      openSendMenu(rt, { x: event.clientX, y: event.clientY })
    },
    true,
  )
}

export function setSendCodeBlock(on: boolean): void {
  prefs.sendCodeBlock = on
  emit()
  persistSoon()
}
