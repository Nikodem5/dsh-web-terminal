// dsh-web-terminal — terminal behaviour preferences (scrollback, cursor, copy on select) and the pure
// maths of per-terminal font zoom. No state or DOM here, so state.ts can validate stored values with it
// and the tests can load it on its own.

export type CursorStyle = 'block' | 'bar' | 'underline'

export interface TermPrefs {
  /** Lines kept above the screen, per terminal. */
  scrollback: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  /** Copy the selection to the clipboard as soon as it is made. Off by default: it overwrites whatever was copied. */
  copyOnSelect: boolean
}

/** 500 lines is still useful; 50 000 lines of a 200-column terminal is a few tens of MB, and every open terminal pays it. */
export const SCROLLBACK_MIN = 500
export const SCROLLBACK_MAX = 50_000
export const SCROLLBACK_DEFAULT = 5000

export const CURSOR_STYLES: readonly CursorStyle[] = ['block', 'bar', 'underline']

export const DEFAULT_TERM: TermPrefs = { scrollback: SCROLLBACK_DEFAULT, cursorStyle: 'block', cursorBlink: true, copyOnSelect: false }

/** A scrollback size inside the bounds; anything that is not a number is the default. */
export function clampScrollback(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return SCROLLBACK_DEFAULT
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(n)))
}

export function isCursorStyle(value: unknown): value is CursorStyle {
  return value === 'block' || value === 'bar' || value === 'underline'
}

/** Stored terminal preferences, repaired field by field; anything malformed keeps its default. */
export function cleanTermPrefs(raw: unknown): TermPrefs {
  const p = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    scrollback: typeof p.scrollback === 'number' ? clampScrollback(p.scrollback) : DEFAULT_TERM.scrollback,
    cursorStyle: isCursorStyle(p.cursorStyle) ? p.cursorStyle : DEFAULT_TERM.cursorStyle,
    cursorBlink: typeof p.cursorBlink === 'boolean' ? p.cursorBlink : DEFAULT_TERM.cursorBlink,
    copyOnSelect: typeof p.copyOnSelect === 'boolean' ? p.copyOnSelect : DEFAULT_TERM.copyOnSelect,
  }
}

// ── font zoom ──────────────────────────────────────────────────────────────

/** Same bounds as the font size setting. */
export const ZOOM_MIN_SIZE = 8
export const ZOOM_MAX_SIZE = 32

/** A stored zoom (whole pixels added to the global font size), or undefined when it is not one. 0 is a real value: "the global size, no shrink to fit". */
export function cleanZoom(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(ZOOM_MAX_SIZE - ZOOM_MIN_SIZE, Math.max(ZOOM_MIN_SIZE - ZOOM_MAX_SIZE, Math.round(value)))
}

/** The font size a zoomed terminal uses: the global size plus the zoom, kept inside the font bounds. */
export function zoomedSize(base: number, zoom: number): number {
  return Math.min(ZOOM_MAX_SIZE, Math.max(ZOOM_MIN_SIZE, Math.round(base + zoom)))
}

/** Wheel distance that is one zoom step (a mouse notch reports about 100). */
export const WHEEL_STEP = 100
/** After this long without wheel events a half-finished step is forgotten. */
export const WHEEL_IDLE_MS = 400

/**
 * Turn wheel movement into whole zoom steps. `acc` carries the part of a step not yet reached (a trackpad
 * pinch reports many tiny deltas); it restarts when the direction flips or the wheel was idle.
 * Scrolling up (negative deltaY) zooms in, so `steps` is positive for it.
 */
export function wheelSteps(acc: number, deltaY: number, deltaMode: number, idleMs = 0): { steps: number; acc: number } {
  const pixels = deltaMode === 1 ? deltaY * 34 : deltaMode === 2 ? deltaY * 400 : deltaY
  if (!Number.isFinite(pixels) || pixels === 0) return { steps: 0, acc }
  const carried = idleMs > WHEEL_IDLE_MS || Math.sign(acc) !== Math.sign(pixels) ? 0 : acc
  const total = carried + pixels
  const whole = Math.trunc(Math.abs(total) / WHEEL_STEP)
  const steps = Math.min(3, whole)
  const rest = total - Math.sign(total) * whole * WHEEL_STEP
  return { steps: -Math.sign(total) * steps || 0, acc: rest }
}
