// dsh-web-terminal — window operations: open, name, order, focus cycling, maximize,
// close and the layout presets. Geometry is in canvas fractions.

import { emit, focusWin, hostInfo, nextZ, persistSoon, prefs, runtimes, store, updateWin } from './state.ts'
import { displayName } from './names.ts'
import { providerForCommand } from './providers.ts'
import { noteFolder, noteSsh } from './preferences.ts'
import { disposeRuntime } from './runtime.ts'
import { sshTitle } from './ssh.ts'
import type { Rect, SshTarget, WinState } from './types.ts'

// ── window operations ──────────────────────────────────────────────────────

let counter = 0
function newId(): string {
  counter++
  return `t${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export interface OpenOptions {
  shell?: string
  title?: string
  startup?: string
  /** Connect to a remote machine over ssh instead of starting a local shell (shell, cwd and startup are then ignored). */
  ssh?: SshTarget
  cwd?: string
  nameManual?: boolean
  rect?: Rect
  pinned?: boolean
  minimized?: boolean
}

/** A new window's normal size, and the smallest it may shrink to when it fills a gap (canvas fractions; about the resize minimum on a typical canvas). */
export const DEFAULT_SIZE = { w: 0.5, h: 0.55 }
export const MIN_PLACED = { w: 0.2, h: 0.2 }
const PLACE_PAD = 0.004

/**
 * The spot for a new window: the largest empty rectangle of the unit canvas not covered by `occupied`,
 * sized `want` or, if the gap is smaller, shrunk to it. Returns undefined when no gap reaches `min`
 * (the caller then cascades). A gap that fits `want` beats a larger one that only fits a shrunk window.
 */
export function findGap(occupied: Rect[], want: { w: number; h: number } = DEFAULT_SIZE, min: { w: number; h: number } = MIN_PLACED): Rect | undefined {
  const eps = 1e-9
  const xs = new Set<number>([0, 1])
  const ys = new Set<number>([0, 1])
  for (const r of occupied) {
    for (const x of [r.x, r.x + r.w]) if (x > 0 && x < 1) xs.add(x)
    for (const y of [r.y, r.y + r.h]) if (y > 0 && y < 1) ys.add(y)
  }
  const sx = [...xs].sort((a, b) => a - b)
  const sy = [...ys].sort((a, b) => a - b)
  const free = (x1: number, y1: number, x2: number, y2: number): boolean =>
    occupied.every((r) => r.x + r.w <= x1 + eps || r.x >= x2 - eps || r.y + r.h <= y1 + eps || r.y >= y2 - eps)
  let best: Rect | undefined
  let bestScore = 0
  let bestGap = 0
  for (let i = 0; i < sx.length; i++) {
    for (let j = i + 1; j < sx.length; j++) {
      const gw = sx[j]! - sx[i]! - PLACE_PAD * 2
      if (gw < min.w - eps) continue
      for (let k = 0; k < sy.length; k++) {
        for (let l = k + 1; l < sy.length; l++) {
          const gh = sy[l]! - sy[k]! - PLACE_PAD * 2
          if (gh < min.h - eps || !free(sx[i]!, sy[k]!, sx[j]!, sy[l]!)) continue
          const w = Math.min(gw, want.w)
          const h = Math.min(gh, want.h)
          const score = w * h
          const gap = gw * gh
          const better = score > bestScore + eps || (Math.abs(score - bestScore) <= eps && gap > bestGap + eps)
          if (best === undefined || better) {
            best = { x: sx[i]! + PLACE_PAD, y: sy[k]! + PLACE_PAD, w, h }
            bestScore = score
            bestGap = gap
          }
        }
      }
    }
  }
  return best
}

/** What visible windows cover: minimized ones take no space; a maximized one counts as the rect it restores to. */
export function occupiedRects(wins: WinState[]): Rect[] {
  return wins
    .filter((w) => !w.minimized)
    .map((w) => (w.maximized && w.restore !== undefined ? w.restore : { x: w.x, y: w.y, w: w.w, h: w.h }))
}

/** Open a new terminal window: in the given rect, else in the largest free gap, else cascaded from the existing ones. */
export function openTerminal(options: OpenOptions = {}): string {
  const visible = store.wins.filter((w) => !w.minimized).length
  const step = (visible % 8) * 0.035
  const ssh = options.ssh
  // An ssh window has no local folder; its remote command is passed to ssh, never typed into a shell.
  const cwd = ssh !== undefined ? '' : (options.cwd ?? prefs.lastCwd)
  const win: WinState = {
    id: newId(),
    title: options.title ?? (ssh !== undefined ? sshTitle(ssh) : `Terminal ${store.wins.length + 1}`),
    nameManual: options.nameManual ?? options.title !== undefined,
    shell: ssh !== undefined ? 'ssh' : (options.shell ?? 'default'),
    cwd: cwd.length > 0 || ssh !== undefined ? cwd : (hostInfo.cwd ?? ''),
    startup: ssh !== undefined ? undefined : options.startup,
    // The agent the startup command starts, remembered so its resume and signals stay tied to it.
    provider: ssh !== undefined ? undefined : providerForCommand(options.startup)?.id,
    ssh,
    ...(options.rect ?? findGap(occupiedRects(store.wins)) ?? { x: 0.04 + step, y: 0.04 + step, ...DEFAULT_SIZE }),
    z: nextZ(),
    pinned: options.pinned ?? false,
    maximized: false,
    minimized: options.minimized ?? false,
  }
  // Newest first: it tops the list and takes the highest z-order, so it never opens behind older windows.
  store.wins = [win, ...store.wins]
  store.focusId = win.id
  noteFolder(win.cwd, win.shell)
  if (ssh !== undefined) noteSsh(ssh)
  emit()
  persistSoon()
  return win.id
}

/** Open another terminal with the same shell, folder and startup command. */
export function duplicateWin(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  openTerminal({ shell: win.shell, cwd: win.cwd, startup: win.startup, ssh: win.ssh, title: `${displayName(win)} copy`, nameManual: true })
}

/** Rename; an empty name hands control back to the program-derived name. */
export function renameWin(id: string, name: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0) updateWin(id, { nameManual: false })
  else updateWin(id, { title: trimmed, nameManual: true })
}

/** Focus the next/previous visible terminal in list order (Ctrl+Alt+←/→); minimized ones are skipped. */
export function cycleFocus(direction: 1 | -1): void {
  const n = store.wins.length
  if (n === 0) return
  const at = store.wins.findIndex((w) => w.id === store.focusId)
  for (let step = 1; step <= n; step++) {
    const next = store.wins[(((at + direction * step) % n) + n) % n]
    if (next === undefined || next.minimized) continue
    focusWin(next.id)
    runtimes.get(next.id)?.term.focus()
    return
  }
}

/** Drop focus from every terminal (click on empty stage space). */
export function clearFocus(): void {
  if (store.focusId === null) return
  store.focusId = null
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  emit()
}

/** Move a window within the list order (drag-reorder in the sidebar). */
export function moveWin(id: string, beforeId: string | null): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined || id === beforeId) return
  const rest = store.wins.filter((w) => w.id !== id)
  const index = beforeId === null ? rest.length : rest.findIndex((w) => w.id === beforeId)
  rest.splice(index < 0 ? rest.length : index, 0, win)
  store.wins = rest
  emit()
  persistSoon()
}

export function toggleMaximize(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined || win.pinned) return
  if (win.maximized) {
    const back = win.restore ?? { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    updateWin(id, { ...back, maximized: false, restore: undefined })
  } else {
    updateWin(id, { restore: { x: win.x, y: win.y, w: win.w, h: win.h }, x: 0, y: 0, w: 1, h: 1, maximized: true })
  }
  focusWin(id)
}

/** Close a window and end its shell on the host. */
export function closeWin(id: string): void {
  disposeRuntime(id, true)
  store.wins = store.wins.filter((w) => w.id !== id)
  store.broadcast.ids.delete(id)
  if (store.focusId === id) store.focusId = null
  if (store.searchId === id) store.searchId = null
  emit()
  persistSoon()
}

export function closeAll(): void {
  store.searchId = null
  for (const id of [...runtimes.keys()]) disposeRuntime(id, true)
  store.wins = []
  store.broadcast.ids.clear()
  store.focusId = null
  emit()
  persistSoon()
}

/** Terminals whose shell is doing something the user might not want to lose. */
export function busyAmong(ids: string[]): WinState[] {
  return store.wins.filter((w) => ids.includes(w.id)).filter((w) => {
    const a = runtimes.get(w.id)?.activity
    return a === 'working' || a === 'needs-you' || a === 'running'
  })
}

/** Layout presets over the non-pinned, non-minimized windows. */
export type Preset = 'grid' | 'columns' | 'rows' | 'main-side' | 'cascade'
export function arrange(preset: Preset): void {
  const targets = store.wins.filter((w) => !w.pinned && !w.minimized)
  const n = targets.length
  if (n === 0) return
  const rects: Rect[] = []
  const gap = 0.004
  const cell = (c: number, r: number, cols: number, rows: number): Rect => ({
    x: c / cols + gap,
    y: r / rows + gap,
    w: 1 / cols - gap * 2,
    h: 1 / rows - gap * 2,
  })
  if (preset === 'grid') {
    const cols = Math.ceil(Math.sqrt(n))
    const rows = Math.ceil(n / cols)
    for (let i = 0; i < n; i++) rects.push(cell(i % cols, Math.floor(i / cols), cols, rows))
  } else if (preset === 'columns') {
    for (let i = 0; i < n; i++) rects.push(cell(i, 0, n, 1))
  } else if (preset === 'rows') {
    for (let i = 0; i < n; i++) rects.push(cell(0, i, 1, n))
  } else if (preset === 'main-side') {
    if (n === 1) rects.push({ x: gap, y: gap, w: 1 - gap * 2, h: 1 - gap * 2 })
    else {
      rects.push({ x: gap, y: gap, w: 0.6 - gap * 2, h: 1 - gap * 2 })
      for (let i = 1; i < n; i++) {
        rects.push({ x: 0.6 + gap, y: (i - 1) / (n - 1) + gap, w: 0.4 - gap * 2, h: 1 / (n - 1) - gap * 2 })
      }
    }
  } else {
    for (let i = 0; i < n; i++) rects.push({ x: 0.03 + i * 0.035, y: 0.03 + i * 0.045, w: 0.5, h: 0.55 })
  }
  const byId = new Map(targets.map((w, i) => [w.id, rects[i]!]))
  store.wins = store.wins.map((w) => {
    const rect = byId.get(w.id)
    return rect === undefined ? w : { ...w, ...rect, maximized: false, restore: undefined }
  })
  emit()
  persistSoon()
}
