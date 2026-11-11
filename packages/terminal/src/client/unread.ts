// dsh-web-terminal — "new since you last looked": where a terminal's output was when the user
// stopped looking at it, a divider at that spot once they come back, and a jump to it.
//
// The marker is an xterm marker on the normal buffer, so it follows the line through scrolling and
// vanishes when the line leaves the scrollback. Full-screen programs (alternate buffer) have no
// such history, so they get no marker, and neither does a terminal of a provider that repaints in
// place on the normal buffer (`repaintsInPlace`, read from the window every time: its startup command
// can change on restart). The pure helpers are tested without a browser; the stateful
// half is driven by the store (focus, page and window changes) and by xterm's own write events.

import type { IDecoration, IMarker } from '@xterm/xterm'
import { emit, store, subscribe } from './state.ts'
import { unattended } from './attention.ts'
import { mission } from './mission.ts'
import { repaintsInPlace } from './providers.ts'
import { matchShortcut } from './shortcuts.ts'
import type { Runtime, WinState } from './types.ts'

// ── pure helpers ───────────────────────────────────────────────────────────

/**
 * Lines added since the marker. The marker sits on the line after the cursor line at blur, so
 * the blur-time cursor line is `markerLine - 1`; in-place repaints leave the cursor line where it
 * was and add nothing.
 */
export function newLinesSince(markerLine: number, cursorLine: number): number {
  return Math.max(0, cursorLine - (markerLine - 1))
}

/** Local HH:mm. */
export function timeLabel(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const dividerText = (at: number): string => `── new since ${timeLabel(at)} ──`

export const pillText = (lines: number): string => `↓ ${lines} new ${lines === 1 ? 'line' : 'lines'}`

/** Ctrl+Shift+U (Cmd on macOS) jumps to the divider. */
export function isUnreadJump(event: KeyboardEvent): boolean {
  return matchShortcut('unread', event)
}

// ── per-terminal state ─────────────────────────────────────────────────────

interface UnreadState {
  rt: Runtime
  /** The user is looking at this terminal right now. */
  looking: boolean
  marker: IMarker | undefined
  /** When the user stopped looking. */
  since: number
  /** New lines since the marker (kept current while looking too, for the pill). */
  lines: number
  /** Shown after the user returns: the divider is wanted (and may wait for the terminal to be opened). */
  wantDivider: boolean
  deco: IDecoration | undefined
  /** The marker is above the visible rows (the pill shows). */
  above: boolean
  /** What the views last had a reason to redraw for (see shownKey): output that changes none of it needs no emit. */
  shown: string
}

const states = new Map<string, UnreadState>()
let wired = false

/** The part of a terminal's state the views draw: the list badge (capped at 99+) and the jump pill. */
function shownKey(st: UnreadState): string {
  const live = st.marker !== undefined && !st.marker.isDisposed
  const badge = live && !st.looking ? Math.min(st.lines, 100) : 0
  const pill = live && st.looking && st.above ? Math.max(1, st.lines) : 0
  return `${badge}|${pill}`
}

/** Redraw the views now, remembering what they were told. */
function publish(st: UnreadState): void {
  st.shown = shownKey(st)
  emit()
}

let framePending = false
/** One redraw per animation frame however much output arrived (a timer too: a hidden page gets no frames). */
function emitSoon(): void {
  if (framePending) return
  framePending = true
  const go = (): void => {
    if (!framePending) return
    framePending = false
    emit()
  }
  requestAnimationFrame(go)
  setTimeout(go, 50)
}

/** Absolute line of the cursor in the active buffer. */
const cursorLine = (rt: Runtime): number => rt.term.buffer.active.baseY + rt.term.buffer.active.cursorY
const onNormal = (rt: Runtime): boolean => rt.term.buffer.active.type === 'normal'

/** This terminal's window runs a provider that repaints in place: none of the feature applies. Read live, never cached. */
const exempt = (id: string): boolean => repaintsInPlace(store.wins.find((w) => w.id === id))

/** Watching the terminal: focused window, Terminals page showing, document visible, not minimized, not scanning the overview. */
function isLooking(id: string): boolean {
  // Overview tiles are tiny and the user is scanning, not reading.
  if (mission.active) return false
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
  if (store.wins.find((w) => w.id === id)?.minimized === true) return false
  return !unattended(id)
}

function dropMarks(st: UnreadState): void {
  const { deco, marker } = st
  st.deco = undefined
  st.marker = undefined
  st.wantDivider = false
  st.above = false
  st.lines = 0
  deco?.dispose()
  marker?.dispose()
}

/** Remember the current end of the output (normal buffer only). */
function setMark(st: UnreadState): void {
  dropMarks(st)
  st.since = Date.now()
  if (!onNormal(st.rt) || exempt(st.rt.id)) return
  // One line past the cursor: the first line anything new will land on.
  const marker = st.rt.term.registerMarker(1)
  st.marker = marker
  // Scrolled out of the scrollback: nothing to point at any more.
  marker.onDispose(() => {
    if (st.marker !== marker) return
    st.deco?.dispose()
    st.deco = undefined
    st.above = false
    publish(st)
  })
}

function showDivider(st: UnreadState): void {
  const { rt, marker } = st
  if (exempt(rt.id)) return
  if (!rt.opened || marker === undefined || marker.isDisposed || st.deco !== undefined) return
  const deco = rt.term.registerDecoration({ marker, x: 0, width: rt.term.cols, height: 1, layer: 'top' })
  if (deco === undefined) return
  st.deco = deco
  deco.onRender((el) => {
    // xterm sizes the element in cells; the divider spans the whole row whatever the width is now.
    el.classList.add('wt-unread-line')
    el.style.width = '100%'
    el.textContent = dividerText(st.since)
  })
  deco.onDispose(() => {
    if (st.deco === deco) st.deco = undefined
  })
}

/** Recompute the line count and whether the marker is scrolled out of view; repaint on change. */
function refresh(st: UnreadState): void {
  const { marker } = st
  if (marker === undefined || marker.isDisposed) return
  const lines = onNormal(st.rt) ? newLinesSince(marker.line, cursorLine(st.rt)) : st.lines
  const above = st.deco !== undefined && marker.line < st.rt.term.buffer.active.viewportY
  st.lines = lines
  st.above = above
  // Printing in the background moves `lines` on every write; only a change of what is drawn is worth a redraw.
  if (shownKey(st) !== st.shown) {
    st.shown = shownKey(st)
    emitSoon()
  }
}

/** Re-decide whether the user is looking, and act on the change. */
function evaluate(st: UnreadState): void {
  const looking = isLooking(st.rt.id)
  // Reassigned to such a provider since the marks were made: take them back.
  if (exempt(st.rt.id)) {
    st.looking = looking
    if (st.marker !== undefined || st.deco !== undefined || st.wantDivider || st.lines > 0) {
      dropMarks(st)
      publish(st)
    }
    return
  }
  if (looking === st.looking) {
    if (looking && st.wantDivider) showDivider(st)
    return
  }
  st.looking = looking
  if (!looking) {
    setMark(st)
  } else if (st.lines > 0 && st.marker !== undefined && !st.marker.isDisposed) {
    st.wantDivider = true
    showDivider(st)
    refresh(st)
  } else {
    dropMarks(st)
  }
  publish(st)
}

/** The windows (by id) as of the last evaluation, to tell which changed. */
let seenWins: readonly WinState[] = []

/**
 * Re-decide the terminals a change can concern. Whether the user is looking needs the focused window, so only
 * the one that was looked at, the one focused now and a window that was edited (minimized, reassigned) can differ.
 */
function evaluateAll(): void {
  const wins = store.wins
  const before = seenWins
  seenWins = wins
  const all = before.length !== wins.length || wins.some((w, i) => w.id !== before[i]!.id)
  const edited = new Set<string>()
  if (!all) for (let i = 0; i < wins.length; i++) if (wins[i] !== before[i]) edited.add(wins[i]!.id)
  for (const st of states.values()) if (all || st.looking || st.rt.id === store.focusId || edited.has(st.rt.id)) evaluate(st)
}

function wire(): void {
  if (wired) return
  wired = true
  subscribe(evaluateAll)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', evaluateAll)
    window.addEventListener('blur', evaluateAll)
    document.addEventListener('visibilitychange', evaluateAll)
  }
}

// ── hooks used by the runtime ──────────────────────────────────────────────

/** Start following a terminal; called once when its runtime is built. */
export function trackUnread(rt: Runtime): void {
  wire()
  const st: UnreadState = { rt, looking: false, marker: undefined, since: Date.now(), lines: 0, wantDivider: false, deco: undefined, above: false, shown: '0|0' }
  states.set(rt.id, st)
  rt.term.onWriteParsed(() => refresh(st))
  rt.term.onScroll(() => refresh(st))
  // Back from a full-screen program while away: the history starts here.
  rt.term.buffer.onBufferChange(() => {
    if (!st.looking && st.marker === undefined && onNormal(rt)) setMark(st)
    publish(st)
  })
  evaluate(st)
  if (!st.looking) setMark(st)
}

/** The screen was replaced (reattach, resync): what it shows is not "new", start counting from its end. */
export function rebaseUnread(rt: Runtime): void {
  const st = states.get(rt.id)
  if (st === undefined) return
  dropMarks(st)
  if (!st.looking) setMark(st)
  publish(st)
}

/** The terminal was opened into the DOM: a divider that was waiting for it can be drawn. */
export function syncUnread(rt: Runtime): void {
  const st = states.get(rt.id)
  if (st !== undefined) evaluate(st)
}

export function untrackUnread(id: string): void {
  const st = states.get(id)
  if (st === undefined) return
  dropMarks(st)
  states.delete(id)
}

// ── what the views read ────────────────────────────────────────────────────

/** New lines in a terminal nobody is looking at (sidebar indicator); 0 otherwise. */
export function unreadCount(id: string): number {
  const st = states.get(id)
  return st !== undefined && !exempt(id) && !st.looking && st.marker !== undefined && !st.marker.isDisposed ? st.lines : 0
}

/** Lines for the floating "jump" pill: shown while the divider is above the visible rows. */
export function unreadPill(id: string): number {
  const st = states.get(id)
  return st !== undefined && !exempt(id) && st.looking && st.above && st.marker !== undefined && !st.marker.isDisposed ? Math.max(1, st.lines) : 0
}

/** Scroll to the divider; false when there is none (or it already scrolled out of the scrollback). */
export function jumpToUnread(id: string): boolean {
  const st = states.get(id)
  if (st === undefined || exempt(id) || st.marker === undefined || st.marker.isDisposed || !st.wantDivider) return false
  st.rt.term.scrollToLine(st.marker.line)
  return true
}

/** Test hook: the line the divider sits on, or -1. */
export function dividerLine(id: string): number {
  const deco = states.get(id)?.deco
  return deco !== undefined && !deco.isDisposed ? deco.marker.line : -1
}
