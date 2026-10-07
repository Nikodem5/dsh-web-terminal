// dsh-web-terminal — window operations: open, name, order, focus cycling, maximize,
// close and the layout presets. Geometry is in canvas fractions.

import { emit, focusWin, hostInfo, nextZ, persistSoon, prefs, runtimes, store, updateWin } from './state.ts'
import { displayName } from './names.ts'
import { noteFolder } from './preferences.ts'
import { disposeRuntime } from './runtime.ts'
import type { Rect, WinState } from './types.ts'

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
  cwd?: string
  nameManual?: boolean
  rect?: Rect
  pinned?: boolean
  minimized?: boolean
}

/** Open a new terminal window, cascaded from the existing ones unless a rect is given. */
export function openTerminal(options: OpenOptions = {}): string {
  const visible = store.wins.filter((w) => !w.minimized).length
  const step = (visible % 8) * 0.035
  const cwd = options.cwd ?? prefs.lastCwd
  const win: WinState = {
    id: newId(),
    title: options.title ?? `Terminal ${store.wins.length + 1}`,
    nameManual: options.nameManual ?? options.title !== undefined,
    shell: options.shell ?? 'default',
    cwd: cwd.length > 0 ? cwd : (hostInfo.cwd ?? ''),
    startup: options.startup,
    ...(options.rect ?? { x: 0.04 + step, y: 0.04 + step, w: 0.5, h: 0.55 }),
    z: nextZ(),
    pinned: options.pinned ?? false,
    maximized: false,
    minimized: options.minimized ?? false,
  }
  // Newest first: it tops the list and takes the highest z-order, so it never opens behind older windows.
  store.wins = [win, ...store.wins]
  store.focusId = win.id
  noteFolder(win.cwd, win.shell)
  emit()
  persistSoon()
  return win.id
}

/** Open another terminal with the same shell, folder and startup command. */
export function duplicateWin(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  openTerminal({ shell: win.shell, cwd: win.cwd, startup: win.startup, title: `${displayName(win)} copy`, nameManual: true })
}

/** Rename; an empty name hands control back to the program-derived name. */
export function renameWin(id: string, name: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0) updateWin(id, { nameManual: false })
  else updateWin(id, { title: trimmed, nameManual: true })
}

/** Focus the next/previous terminal in list order (Ctrl+Alt+←/→). */
export function cycleFocus(direction: 1 | -1): void {
  const n = store.wins.length
  if (n === 0) return
  const at = store.wins.findIndex((w) => w.id === store.focusId)
  const next = store.wins[(at + direction + n) % n]
  if (next === undefined) return
  focusWin(next.id)
  runtimes.get(next.id)?.term.focus()
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
    return a === 'working' || a === 'waiting'
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
