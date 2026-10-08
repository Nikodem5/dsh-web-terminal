// dsh-web-terminal — "mission control": a god view of every terminal.
//
// A pure view-layer transform. Each window keeps its real pixel size (so no xterm fit, no resize frame,
// no TUI redraw) and is merely CSS-scaled into a grid tile; WinState is never touched, so the layout
// cannot be persisted in overview form and leaving restores it exactly. Only the flag, the filter
// and the selection live here.

import { emit, focusWin, runtimes } from './state.ts'
import type { Rect } from './types.ts'

export interface MissionState {
  active: boolean
  query: string
  /** Selected tile; resolved against the visible tiles by `resolveSel`. */
  sel: string | null
  /** Terminal to focus once the view has left overview (set by a pick, consumed by the view). */
  pendingFocus: string | null
}

export const mission: MissionState = { active: false, query: '', sel: null, pendingFocus: null }

export function isOverview(): boolean {
  return mission.active
}

/** Ctrl+Shift+Space toggles overview. Unused by browsers; listed in runtime's isAppShortcut so xterm never sees it. */
export function isMissionShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && (event.code === 'Space' || event.key === ' ')
}

export function enterOverview(focusId: string | null): void {
  if (mission.active) return
  mission.active = true
  mission.query = ''
  mission.sel = focusId
  mission.pendingFocus = null
  // Keep keystrokes out of the terminal that held focus; the view handles keys itself.
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
  emit()
}

/** Leave overview; with an id, focus (and un-minimize) that terminal, otherwise change nothing. */
export function exitOverview(pick: string | null = null): void {
  if (!mission.active) return
  mission.active = false
  mission.query = ''
  mission.sel = null
  mission.pendingFocus = pick
  if (pick !== null) focusWin(pick)
  else emit()
}

export function toggleOverview(focusId: string | null): void {
  if (mission.active) exitOverview()
  else enterOverview(focusId)
}

export function setMissionQuery(query: string): void {
  mission.query = query
  emit()
}

export function setMissionSel(id: string | null): void {
  mission.sel = id
  emit()
}

/** Focus the terminal chosen by the last pick, once its window is back in place. */
export function takePendingFocus(): void {
  const id = mission.pendingFocus
  mission.pendingFocus = null
  if (id !== null) runtimes.get(id)?.term.focus()
}

// ── pure layout and filter ─────────────────────────────────────────────────

export interface Size {
  w: number
  h: number
}

export interface TilePlan {
  id: string
  /** Tile frame in stage pixels (header + body). */
  tile: Rect
  /** Where the live window goes: CSS `translate(tx, ty) scale(scale)` with origin 0 0, relative to its own left/top. */
  scale: number
  tx: number
  ty: number
}

export interface PlanOptions {
  gap?: number
  /** Height of the tile's title strip above the scaled terminal. */
  header?: number
  pad?: number
}

/** Scale `inner` to fit inside `box` (never upscaled), centred: the letterbox. */
export function fitInto(inner: Size, box: Rect): { scale: number; x: number; y: number } {
  const scale = Math.min(1, box.w / Math.max(1, inner.w), box.h / Math.max(1, inner.h))
  return { scale, x: box.x + (box.w - inner.w * scale) / 2, y: box.y + (box.h - inner.h * scale) / 2 }
}

/** Largest scale a typical terminal gets for a given column count; used to pick the grid shape. */
function bestCols(n: number, stage: Size, gap: number, header: number, aspect: number): number {
  let best = 1
  let bestScore = -1
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const tw = (stage.w - gap * (cols + 1)) / cols
    const th = (stage.h - gap * (rows + 1)) / rows - header
    if (tw <= 0 || th <= 0) continue
    // Area of a terminal of the given aspect inside the tile body.
    const w = Math.min(tw, th * aspect)
    const score = w * (w / aspect)
    // Prefer fewer empty cells on a tie (a lone tile in a last row wastes less with a better-filled grid).
    if (score > bestScore + 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && cols * rows < best * Math.ceil(n / best))) {
      bestScore = score
      best = cols
    }
  }
  return best
}

/**
 * Grid of tiles filling the stage, one per item (its real stage rect x/y/w/h), scaled to fit its tile body.
 * Columns follow ceil(sqrt(n)) bent by the stage aspect ratio (a wide stage gets more columns).
 */
export function planOverview(items: { id: string; x: number; y: number; w: number; h: number }[], stage: Size, options: PlanOptions = {}): { cols: number; rows: number; tiles: TilePlan[] } {
  const gap = options.gap ?? 12
  const header = options.header ?? 28
  const pad = options.pad ?? 6
  const n = items.length
  if (n === 0) return { cols: 0, rows: 0, tiles: [] }
  const mean = items.reduce((sum, i) => sum + i.w / Math.max(1, i.h), 0) / n
  const cols = bestCols(n, stage, gap, header, mean)
  const rows = Math.ceil(n / cols)
  const tw = (stage.w - gap * (cols + 1)) / cols
  const th = (stage.h - gap * (rows + 1)) / rows
  const tiles = items.map((item, i): TilePlan => {
    const tile = { x: gap + (i % cols) * (tw + gap), y: gap + Math.floor(i / cols) * (th + gap), w: tw, h: th }
    const body = { x: tile.x + pad, y: tile.y + header, w: tile.w - pad * 2, h: tile.h - header - pad }
    const fit = fitInto(item, body)
    return { id: item.id, tile, scale: fit.scale, tx: fit.x - item.x, ty: fit.y - item.y }
  })
  return { cols, rows, tiles }
}

/** Case-insensitive; every whitespace-separated term must appear in the name or the folder. */
export function filterTiles<T extends { name: string; cwd: string }>(items: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (terms.length === 0) return items
  return items.filter((i) => {
    const hay = `${i.name}\n${i.cwd}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

/** The selection if it is still visible, otherwise the first visible tile. */
export function resolveSel(ids: string[], sel: string | null): string | null {
  return sel !== null && ids.includes(sel) ? sel : (ids[0] ?? null)
}

/** Arrow-key movement over a row-major grid; clamps at the edges. */
export function moveSel(count: number, cols: number, at: number, key: string): number {
  if (count === 0) return -1
  const d = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -cols : key === 'ArrowDown' ? cols : 0
  const next = at + d
  return next < 0 || next >= count ? at : next
}
