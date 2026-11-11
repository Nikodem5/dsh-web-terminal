// dsh-web-terminal — where a new window goes: the largest free gap of the canvas, else a cascade.
// Geometry is in canvas fractions (0..1). Pure apart from the remembered stage size, so the tests load it alone.

import type { Rect } from './types.ts'

/** A new window's normal size, and the smallest it may shrink to when it fills a gap (canvas fractions; about the resize minimum on a typical canvas). */
export const DEFAULT_SIZE = { w: 0.5, h: 0.55 }
export const MIN_PLACED = { w: 0.2, h: 0.2 }
const PLACE_PAD = 0.004
const EPS = 1e-9

/** The resize minimum of a window in pixels (terminals-view.tsx MIN_W / MIN_H): placement never opens one smaller. */
export const MIN_WINDOW_PX = { w: 240, h: 130 }

export interface Stage {
  w: number
  h: number
}

let stage: Stage | undefined

/** The canvas size in pixels, reported by the view; until it is known the fractions alone decide. */
export function noteStageSize(w: number, h: number): void {
  stage = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : undefined
}

/**
 * The preferred and the smallest size of a placed window for a canvas. On a small canvas a fraction of
 * 0.2 is below the resize minimum, so both grow to it (never past what fits at all).
 */
export function placementSizes(canvas: Stage | undefined = stage): { want: { w: number; h: number }; min: { w: number; h: number } } {
  if (canvas === undefined) return { want: { ...DEFAULT_SIZE }, min: { ...MIN_PLACED } }
  const room = 1 - PLACE_PAD * 2 - EPS
  const min = { w: Math.min(room, Math.max(MIN_PLACED.w, MIN_WINDOW_PX.w / canvas.w)), h: Math.min(room, Math.max(MIN_PLACED.h, MIN_WINDOW_PX.h / canvas.h)) }
  return { want: { w: Math.min(room, Math.max(DEFAULT_SIZE.w, min.w)), h: Math.min(room, Math.max(DEFAULT_SIZE.h, min.h)) }, min }
}

/** Sorted, de-duplicated grid lines (values closer than EPS are one line). */
function lines(values: Iterable<number>): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  for (const v of sorted) if (out.length === 0 || v - out[out.length - 1]! > EPS) out.push(v)
  return out
}

/**
 * The spot for a new window: the largest empty rectangle of the unit canvas not covered by `occupied`,
 * sized `want` or, if the gap is smaller, shrunk to it. Returns undefined when no gap reaches `min`
 * (the caller then cascades). A gap that fits `want` beats a larger one that only fits a shrunk window.
 *
 * The canvas is cut along every window edge into a grid of cells, each free or covered. For every top-left
 * cell the empty rectangle is grown downward one row at a time, its width limited by the free run to the
 * right in each row it spans: O(cells x rows) instead of testing every rectangle against every window.
 * Rectangles are still compared by what a window would get out of them, as before.
 */
export function findGap(occupied: Rect[], want: { w: number; h: number } = DEFAULT_SIZE, min: { w: number; h: number } = MIN_PLACED): Rect | undefined {
  const xs = new Set<number>([0, 1])
  const ys = new Set<number>([0, 1])
  for (const r of occupied) {
    for (const x of [r.x, r.x + r.w]) if (x > 0 && x < 1) xs.add(x)
    for (const y of [r.y, r.y + r.h]) if (y > 0 && y < 1) ys.add(y)
  }
  const sx = lines(xs)
  const sy = lines(ys)
  const nx = sx.length - 1
  const ny = sy.length - 1
  // taken[row * nx + col]: some window covers part of the cell.
  const taken = new Uint8Array(nx * ny)
  for (const r of occupied) {
    const x2 = r.x + r.w
    const y2 = r.y + r.h
    for (let row = 0; row < ny; row++) {
      if (r.y + EPS >= sy[row + 1]! || y2 - EPS <= sy[row]!) continue
      for (let col = 0; col < nx; col++) {
        if (r.x + EPS < sx[col + 1]! && x2 - EPS > sx[col]!) taken[row * nx + col] = 1
      }
    }
  }
  // run[row * nx + col]: free cells from this one to the right in its row.
  const run = new Uint16Array(nx * ny)
  for (let row = 0; row < ny; row++) {
    for (let col = nx - 1; col >= 0; col--) run[row * nx + col] = taken[row * nx + col] === 1 ? 0 : (col + 1 < nx ? run[row * nx + col + 1]! : 0) + 1
  }
  let best: Rect | undefined
  let bestScore = 0
  let bestGap = 0
  for (let col = 0; col < nx; col++) {
    for (let top = 0; top < ny; top++) {
      let width = nx - col
      for (let bottom = top + 1; bottom <= ny; bottom++) {
        width = Math.min(width, run[(bottom - 1) * nx + col]!)
        if (width === 0) break
        const gw = sx[col + width]! - sx[col]! - PLACE_PAD * 2
        const gh = sy[bottom]! - sy[top]! - PLACE_PAD * 2
        if (gw < min.w - EPS || gh < min.h - EPS) continue
        const w = Math.min(gw, want.w)
        const h = Math.min(gh, want.h)
        const score = w * h
        const gap = gw * gh
        if (best === undefined || score > bestScore + EPS || (Math.abs(score - bestScore) <= EPS && gap > bestGap + EPS)) {
          best = { x: sx[col]! + PLACE_PAD, y: sy[top]! + PLACE_PAD, w, h }
          bestScore = score
          bestGap = gap
        }
      }
    }
  }
  return best
}

const usable = (r: Rect): boolean => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0

/** What visible windows cover: minimized ones take no space; a maximized one counts as the rect it restores to. Damaged rects are ignored. */
export function occupiedRects(wins: readonly { x: number; y: number; w: number; h: number; minimized: boolean; maximized: boolean; restore?: Rect }[]): Rect[] {
  return wins
    .filter((w) => !w.minimized)
    .map((w) => (w.maximized && w.restore !== undefined ? w.restore : { x: w.x, y: w.y, w: w.w, h: w.h }))
    .filter(usable)
}

const near = (a: Rect, b: Rect): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01

/**
 * The cascade fallback: the default size, stepped down and right by how many windows are open. The step
 * wraps after eight, so a position already taken by a window of the same size is skipped, and the window
 * is kept inside the canvas.
 */
export function cascadeRect(occupied: Rect[], want: { w: number; h: number } = DEFAULT_SIZE): Rect {
  const w = Math.min(1, want.w)
  const h = Math.min(1, want.h)
  const at = (n: number): Rect => {
    const step = (n % 8) * 0.035
    return { x: Math.max(0, Math.min(0.04 + step, 1 - w)), y: Math.max(0, Math.min(0.04 + step, 1 - h)), w, h }
  }
  for (let i = 0; i < 8; i++) {
    const r = at(occupied.length + i)
    if (!occupied.some((o) => near(o, r))) return r
  }
  return at(occupied.length)
}

/**
 * A rect given by a caller (a saved layout) made safe: finite, not smaller than a title bar and not
 * entirely off the canvas. A window dragged partly off-screen keeps its position as long as a grip stays visible.
 */
export function reachableRect(r: Rect): Rect {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
  const w = Number.isFinite(r.w) ? clamp(r.w, 0.05, 1) : DEFAULT_SIZE.w
  const h = Number.isFinite(r.h) ? clamp(r.h, 0.05, 1) : DEFAULT_SIZE.h
  return { x: Number.isFinite(r.x) ? clamp(r.x, -w + 0.1, 0.9) : 0.04, y: Number.isFinite(r.y) ? clamp(r.y, 0, 0.95) : 0.04, w, h }
}

/** Where the next window goes: the largest gap, else the cascade; sized for the canvas the view reported. */
export function placeNew(occupied: Rect[]): Rect {
  const { want, min } = placementSizes()
  return findGap(occupied, want, min) ?? cascadeRect(occupied, want)
}
