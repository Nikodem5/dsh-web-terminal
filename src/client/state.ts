// dsh-web-terminal — shared client state: the window store, preferences, the live
// runtime map, change notification and persistence. Every other module reads and
// mutates these; nothing here depends on them.
//
// The Terminals tab is a conversation *view*, so React unmounts it whenever the
// user flips to Chat or another session. A terminal must survive that, so the
// xterm instance and its WebSocket live in `runtimes` at module scope and the view
// only re-parents their DOM node. Geometry is stored as fractions of the canvas so
// a layout follows window resizes and sidebar toggles.

import { cleanSsh, cleanSshList } from './ssh.ts'
import type { FontPrefs, HostInfo, LayoutWin, Prefs, Rect, Runtime, SavedLayout, Store, WinState } from './types.ts'

// ── persistence ────────────────────────────────────────────────────────────

export const K_LAYOUT = 'dsh.web-terminal.layout.v1'
export const K_PREFS = 'dsh.web-terminal.prefs.v1'

// Mono (no ligatures) first: xterm draws no ligatures without an addon, so Code's ligature glyphs would only widen cells.
export const DEFAULT_FONT: FontPrefs = {
  family: "'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  size: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  boldWeight: 600,
  minContrast: 4.5,
}

/** Pre-readability defaults: a stored font that is exactly this was never really chosen, so it adopts the new defaults. */
const OLD_DEFAULT_FONT = {
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
  sshRecents: [],
  sshFavourites: [],
  layouts: [],
  lastShell: 'default',
  lastCwd: '',
  sessionCwd: '',
  sidebar: true,
  agentsPanel: false,
  notify: true,
  sound: true,
  hungMinutes: 10,
  pathTarget: 'vscode',
  pathTemplate: '',
  shellIntegration: true,
  sendCodeBlock: true,
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

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isRect = (v: unknown): v is Rect => isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h)

/** A stored window, repaired or dropped: a bad geometry would break the layout, a bad z would make zTop NaN. */
const isGrid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 1000

function cleanWin(raw: unknown, index: number): WinState | undefined {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || !isRect(raw)) return undefined
  // Re-validated on load: a hand-edited or damaged target is dropped rather than handed to ssh.
  const ssh = cleanSsh(raw.ssh)
  return {
    id: raw.id,
    title: str(raw.title, 'Terminal'),
    nameManual: raw.nameManual === true,
    autoName: typeof raw.autoName === 'string' ? raw.autoName : undefined,
    shell: ssh !== undefined ? 'ssh' : raw.shell === 'ssh' ? 'default' : str(raw.shell, 'default'),
    cwd: str(raw.cwd, ''),
    startup: typeof raw.startup === 'string' ? raw.startup : undefined,
    ssh,
    x: raw.x,
    y: raw.y,
    w: raw.w,
    h: raw.h,
    // z only orders windows, so a missing one is replaced by the list position instead of dropping the window.
    z: isNum(raw.z) ? raw.z : index + 1,
    pinned: raw.pinned === true,
    maximized: raw.maximized === true,
    minimized: raw.minimized === true,
    restore: isRect(raw.restore) ? { x: raw.restore.x, y: raw.restore.y, w: raw.restore.w, h: raw.restore.h } : undefined,
    gen: isNum(raw.gen) ? raw.gen : undefined,
    agentSession: typeof raw.agentSession === 'string' ? raw.agentSession : undefined,
    cols: isGrid(raw.cols) ? raw.cols : undefined,
    rows: isGrid(raw.rows) ? raw.rows : undefined,
  }
}

function cleanLayout(raw: unknown): SavedLayout | undefined {
  if (!isObj(raw) || typeof raw.name !== 'string' || raw.name.length === 0 || !Array.isArray(raw.wins)) return undefined
  const wins: LayoutWin[] = []
  for (const w of raw.wins) {
    if (!isObj(w) || !isRect(w)) continue
    const ssh = cleanSsh(w.ssh)
    wins.push({
      title: str(w.title, 'Terminal'),
      nameManual: w.nameManual === true,
      shell: ssh !== undefined ? 'ssh' : w.shell === 'ssh' ? 'default' : str(w.shell, 'default'),
      cwd: str(w.cwd, ''),
      startup: typeof w.startup === 'string' ? w.startup : undefined,
      ssh,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      pinned: w.pinned === true,
      minimized: w.minimized === true,
    })
  }
  return { name: raw.name, savedAt: isNum(raw.savedAt) ? raw.savedAt : 0, wins }
}

/** Copy the valid fields of stored preferences over the defaults; anything malformed keeps its default. */
function applyPrefs(p: Record<string, unknown>): void {
  if (Array.isArray(p.recents)) prefs.recents = p.recents.filter((v): v is string => typeof v === 'string').slice(0, 12)
  if (Array.isArray(p.favourites)) prefs.favourites = p.favourites.filter((v): v is string => typeof v === 'string')
  if (Array.isArray(p.sshRecents)) prefs.sshRecents = cleanSshList(p.sshRecents).slice(0, 10)
  if (Array.isArray(p.sshFavourites)) prefs.sshFavourites = cleanSshList(p.sshFavourites)
  if (Array.isArray(p.layouts)) prefs.layouts = p.layouts.map(cleanLayout).filter((l): l is SavedLayout => l !== undefined)
  if (typeof p.lastShell === 'string') prefs.lastShell = p.lastShell
  if (typeof p.lastCwd === 'string') prefs.lastCwd = p.lastCwd
  if (typeof p.sessionCwd === 'string') prefs.sessionCwd = p.sessionCwd
  for (const key of ['fontCustom', 'autoFont', 'sidebar', 'agentsPanel', 'notify', 'sound'] as const) if (typeof p[key] === 'boolean') prefs[key] = p[key] as boolean
  if (isNum(p.fitCols)) prefs.fitCols = clamp(Math.round(p.fitCols), 40, 240)
  if (isNum(p.hungMinutes)) prefs.hungMinutes = clamp(Math.round(p.hungMinutes), 0, 240)
  if (p.pathTarget === 'vscode' || p.pathTarget === 'cursor' || p.pathTarget === 'default' || p.pathTarget === 'custom') prefs.pathTarget = p.pathTarget
  if (typeof p.sendCodeBlock === 'boolean') prefs.sendCodeBlock = p.sendCodeBlock
  if (typeof p.pathTemplate === 'string') prefs.pathTemplate = p.pathTemplate.slice(0, 500)
  if (typeof p.shellIntegration === 'boolean') prefs.shellIntegration = p.shellIntegration
  if (p.termTheme === 'dark' || p.termTheme === 'light' || p.termTheme === 'auto') prefs.termTheme = p.termTheme
  const font = isObj(p.font) ? p.font : {}
  // "Reset font" and any edit set fontCustom, so a stored font equal to the old default is also treated as unchosen.
  const wasOldDefault = font.family === OLD_DEFAULT_FONT.family && font.size === OLD_DEFAULT_FONT.size && font.lineHeight === OLD_DEFAULT_FONT.lineHeight
  if (wasOldDefault) prefs.fontCustom = false
  prefs.font = prefs.fontCustom
    ? {
        family: typeof font.family === 'string' && font.family.trim().length > 0 ? font.family : DEFAULT_FONT.family,
        size: isNum(font.size) ? clamp(font.size, 8, 32) : DEFAULT_FONT.size,
        lineHeight: isNum(font.lineHeight) ? clamp(font.lineHeight, 1, 2) : DEFAULT_FONT.lineHeight,
        letterSpacing: isNum(font.letterSpacing) ? clamp(Math.round(font.letterSpacing), 0, 2) : DEFAULT_FONT.letterSpacing,
        boldWeight: isNum(font.boldWeight) ? clamp(Math.round(font.boldWeight / 100) * 100, 100, 900) : DEFAULT_FONT.boldWeight,
        minContrast: isNum(font.minContrast) ? clamp(font.minContrast, 1, 21) : DEFAULT_FONT.minContrast,
      }
    : { ...DEFAULT_FONT }
}

/**
 * Read one stored JSON object. An unreadable value is copied to `<key>.corrupt` before anything can
 * overwrite it, so a hand-editable record is never silently destroyed by the next save.
 */
function readStored(key: string): Record<string, unknown> | undefined {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (isObj(parsed)) return parsed
  } catch {}
  try {
    if (raw !== null) localStorage.setItem(`${key}.corrupt`, raw)
  } catch {}
  return undefined
}

/** Restore saved windows and preferences once per page load. Layout and preferences fail independently. */
let hydrated = false
export function hydrate(): void {
  if (hydrated) return
  hydrated = true
  const layout = readStored(K_LAYOUT)
  if (layout !== undefined && Array.isArray(layout.wins)) {
    const seen = new Set<string>()
    store.wins = layout.wins
      .map(cleanWin)
      .filter((w): w is WinState => w !== undefined && !seen.has(w.id) && seen.add(w.id) !== undefined)
    store.zTop = Math.max(1, isNum(layout.zTop) ? layout.zTop : 1, ...store.wins.map((w) => w.z))
  }
  const stored = readStored(K_PREFS)
  if (stored !== undefined) applyPrefs(stored)
}

/**
 * Fetch the host probe once; harmless to call repeatedly. A failed probe is forgotten so the next
 * call retries, and `refreshHostInfo` forces a new one (the host's per-process settings file changes
 * on every restart).
 */
let infoRequested = false
let infoDone: Promise<void> | undefined
let infoSeq = 0
let infoPending = false
export function loadHostInfo(): void {
  if (infoRequested) return
  infoRequested = true
  const seq = ++infoSeq
  infoPending = true
  infoDone = fetch('/api/dsh-web-terminal/info', { headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((info: HostInfo | undefined) => {
      if (seq !== infoSeq) return // superseded by a refresh
      infoPending = false
      if (!isObj(info)) {
        infoRequested = false
        return
      }
      hostInfo = info
      emit()
    })
    .catch(() => {
      if (seq !== infoSeq) return
      infoPending = false
      infoRequested = false
    })
}

/** Drop what the host told us and probe again; the old settings file path may belong to a dead host. */
export function refreshHostInfo(): void {
  hostInfo = { ...hostInfo, agent: undefined }
  infoRequested = false
  loadHostInfo()
}

/**
 * Resolves once the host probe has answered (or failed, or `timeoutMs` passed).
 * The probe is slow on a cold start (it looks shells up on PATH), and a startup command typed
 * before it arrives would miss the host's agent-hook settings file. An answered probe that named no
 * settings file is asked again, since the host may only have been starting up.
 */
export function hostInfoReady(timeoutMs = 10_000): Promise<void> {
  if (infoRequested && !infoPending && typeof hostInfo.agent?.claudeSettings !== 'string') refreshHostInfo()
  else loadHostInfo()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  return Promise.race([infoDone ?? Promise.resolve(), timeout]).finally(() => clearTimeout(timer))
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
