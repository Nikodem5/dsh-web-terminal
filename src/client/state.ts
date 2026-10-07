// dsh-web-terminal — shared client state: the window store, preferences, the live
// runtime map, change notification and persistence. Every other module reads and
// mutates these; nothing here depends on them.
//
// The Terminals tab is a conversation *view*, so React unmounts it whenever the
// user flips to Chat or another session. A terminal must survive that, so the
// xterm instance and its WebSocket live in `runtimes` at module scope and the view
// only re-parents their DOM node. Geometry is stored as fractions of the canvas so
// a layout follows window resizes and sidebar toggles.

import type { FontPrefs, HostInfo, Prefs, Runtime, Store, WinState } from './types.ts'

// ── persistence ────────────────────────────────────────────────────────────

export const K_LAYOUT = 'dsh.web-terminal.layout.v1'
export const K_PREFS = 'dsh.web-terminal.prefs.v1'

export const DEFAULT_FONT: FontPrefs = {
  family: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
  size: 12,
  lineHeight: 1.2,
}

export const prefs: Prefs = {
  font: { ...DEFAULT_FONT },
  fontCustom: false,
  autoFont: true,
  fitCols: 100,
  termTheme: 'dark',
  recents: [],
  favourites: [],
  layouts: [],
  lastShell: 'default',
  lastCwd: '',
  sidebar: true,
  notify: true,
  sound: true,
  hungMinutes: 10,
}

export const store: Store = { wins: [], zTop: 1, focusId: null, searchId: null, version: 0, broadcast: { on: false, live: false, ids: new Set() } }
export const runtimes = new Map<string, Runtime>()
const listeners = new Set<() => void>()
let persistTimer: ReturnType<typeof setTimeout> | undefined
export let hostInfo: HostInfo = {}

export function emit(): void {
  store.version++
  for (const listener of listeners) listener()
}

export function persistSoon(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(K_LAYOUT, JSON.stringify({ wins: store.wins, zTop: store.zTop }))
      localStorage.setItem(K_PREFS, JSON.stringify(prefs))
    } catch {}
  }, 250)
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getVersion = (): number => store.version
export const getWins = (): readonly WinState[] => store.wins
export const getFocusId = (): string | null => store.focusId
export const getSearchId = (): string | null => store.searchId
export const getRuntime = (id: string): Runtime | undefined => runtimes.get(id)
export const getPrefs = (): Readonly<Prefs> => prefs
export const getBroadcast = (): Readonly<Store['broadcast']> => store.broadcast

/** Restore saved windows and preferences once per page load. */
let hydrated = false
export function hydrate(): void {
  if (hydrated) return
  hydrated = true
  try {
    const raw = localStorage.getItem(K_LAYOUT)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { wins?: WinState[]; zTop?: number }
      if (Array.isArray(parsed.wins)) {
        store.wins = parsed.wins.filter((w) => typeof w?.id === 'string')
        store.zTop = Math.max(1, parsed.zTop ?? 1, ...store.wins.map((w) => w.z))
      }
    }
    const p = localStorage.getItem(K_PREFS)
    if (p !== null) {
      const parsed = JSON.parse(p) as Partial<Prefs>
      Object.assign(prefs, parsed)
      prefs.font = parsed.fontCustom === true ? { ...DEFAULT_FONT, ...(parsed.font ?? {}) } : { ...DEFAULT_FONT }
    }
  } catch {}
}

/** Fetch the host probe once; harmless to call repeatedly. */
let infoRequested = false
export function loadHostInfo(): void {
  if (infoRequested) return
  infoRequested = true
  fetch('/api/dsh-web-terminal/info', { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((info: HostInfo | undefined) => {
      if (info === undefined) return
      hostInfo = info
      emit()
    })
    .catch(() => {})
}

// ── shared window mutations ────────────────────────────────────────────────
// Kept here (not in windows.ts) because the runtime and attention modules need them
// and windows.ts depends on the runtime module.

/** Next z-order value; renumbers the stack when it gets large so it stays small and bounded. */
export function nextZ(): number {
  if (store.zTop > 4000) {
    const ordered = [...store.wins].sort((a, b) => a.z - b.z)
    const rank = new Map(ordered.map((w, i) => [w.id, i + 1]))
    store.wins = store.wins.map((w) => ({ ...w, z: rank.get(w.id) ?? 1 }))
    store.zTop = ordered.length
  }
  return ++store.zTop
}

/** Patch one window. */
export function updateWin(id: string, patch: Partial<WinState>): void {
  store.wins = store.wins.map((w) => (w.id === id ? { ...w, ...patch } : w))
  emit()
  persistSoon()
}

/** Raise a window above the others, give it focus and clear its attention flag. */
export function focusWin(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  const rt = runtimes.get(id)
  let changed = false
  if (rt !== undefined && rt.attention) {
    rt.attention = false
    rt.attentionLevel = null
    rt.attentionLabel = ''
    rt.attentionReason = ''
    changed = true
  }
  if (!(win.z === store.zTop && store.focusId === id && !win.minimized)) {
    store.focusId = id
    const z = nextZ()
    store.wins = store.wins.map((w) => (w.id === id ? { ...w, z: z, minimized: false } : w))
    changed = true
    persistSoon()
  }
  if (changed) emit()
}
