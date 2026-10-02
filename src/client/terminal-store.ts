// dsh-web-terminal — client state: window geometry (persisted), live terminal
// runtimes (xterm + socket, page-lifetime), activity tracking, preferences.
//
// The Terminals tab is a conversation *view*, so React unmounts it whenever the
// user flips to Chat or another session. A terminal must survive that, so the
// xterm instance and its WebSocket live here at module scope and the view only
// re-parents their DOM node. Geometry is stored as fractions of the canvas so a
// layout follows window resizes and sidebar toggles.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'

// ── types ──────────────────────────────────────────────────────────────────

/** Rectangle in canvas fractions (0..1). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One terminal window's persisted description. */
export interface WinState extends Rect {
  id: string
  /** Name chosen by the user, or the default when `nameManual` is false. */
  title: string
  /** True once the user renamed it; stops the auto name from overriding. */
  nameManual?: boolean
  /** Last name derived from the program's own title (e.g. the Claude session). */
  autoName?: string
  shell: string
  cwd: string
  /** Command typed into a freshly spawned shell (e.g. `claude`). */
  startup?: string
  z: number
  pinned: boolean
  maximized: boolean
  minimized: boolean
  /** Geometry to return to when un-maximized. */
  restore?: Rect
  /** Bumped on restart so the host never confuses a new shell with the one being killed. */
  gen?: number
}

/** Connection phase of one terminal runtime. */
export type Conn = 'connecting' | 'live' | 'exited' | 'lost' | 'failed'

/** What the terminal is doing right now, for the status dot and list. */
export type Activity = 'working' | 'waiting' | 'idle' | 'exited' | 'offline'

/** Live (non-serializable) side of one terminal window. */
export interface Runtime {
  id: string
  holder: HTMLDivElement
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Current find result (1-based index, 0 when none) and total matches. */
  searchIndex: number
  searchCount: number
  socket: WebSocket | null
  conn: Conn
  detail: string
  /** Raw OSC title the program set. */
  title: string
  killed: boolean
  retry: number
  timer: ReturnType<typeof setTimeout> | undefined
  lastCols: number
  lastRows: number
  activity: Activity
  /** Host says a child process runs under the shell; undefined = unknown. */
  hostBusy: boolean | undefined
  lastOutputAt: number
  lastInputAt: number
  workStart: number
  /** Needs the user's eyes: finished, exited or rang the bell while unattended. */
  attention: boolean
  attentionReason: string
}

/** Font preferences shared by every terminal. */
export interface FontPrefs {
  family: string
  size: number
  lineHeight: number
}

/** One window inside a saved layout. */
export type LayoutWin = Pick<WinState, 'title' | 'nameManual' | 'shell' | 'cwd' | 'startup' | 'x' | 'y' | 'w' | 'h' | 'pinned' | 'minimized'>

export interface SavedLayout {
  name: string
  savedAt: number
  wins: LayoutWin[]
}

/** Host probe results shared with the view. */
export interface HostInfo {
  platform?: string
  shell?: string
  shells?: { id: string; label: string }[]
  cwd?: string
  claude?: { available?: boolean; path?: string | null }
  maxSessions?: number
}

// ── persistence ────────────────────────────────────────────────────────────

const K_LAYOUT = 'dsh.web-terminal.layout.v1'
const K_PREFS = 'dsh.web-terminal.prefs.v1'

export const DEFAULT_FONT: FontPrefs = {
  family: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
  size: 12,
  lineHeight: 1.2,
}

interface Prefs {
  font: FontPrefs
  /** True once the user changed the font, so a new default never overrides their choice. */
  fontCustom: boolean
  /** Shrink the font in narrow windows so about `fitCols` columns stay visible (never above `font.size`). */
  autoFont: boolean
  fitCols: number
  /** Terminal colours: fixed dark/light, or follow the app theme. Agent TUIs assume dark, hence the default. */
  termTheme: 'dark' | 'light' | 'auto'
  recents: string[]
  favourites: string[]
  layouts: SavedLayout[]
  lastShell: string
  lastCwd: string
  sidebar: boolean
  notify: boolean
}

const prefs: Prefs = {
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
}

/** Everything the view reads; mutated in place, `version` bumps on change. */
interface Store {
  wins: WinState[]
  zTop: number
  focusId: string | null
  /** Window whose find bar is open. */
  searchId: string | null
  version: number
  broadcast: { on: boolean; live: boolean; ids: Set<string> }
}

const store: Store = { wins: [], zTop: 1, focusId: null, searchId: null, version: 0, broadcast: { on: false, live: false, ids: new Set() } }
const runtimes = new Map<string, Runtime>()
const listeners = new Set<() => void>()
let persistTimer: ReturnType<typeof setTimeout> | undefined
export let hostInfo: HostInfo = {}

function emit(): void {
  store.version++
  for (const listener of listeners) listener()
}

function persistSoon(): void {
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

// ── names ──────────────────────────────────────────────────────────────────

/** Last path segment, for compact folder labels. */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * Turn a program-set terminal title into a window name, or undefined when it is
 * only the shell's own path/banner. Claude Code puts a status glyph in front of
 * its session title ("✳ Fix login bug"); that prefix is dropped.
 */
export function cleanTitle(raw: string, cwd: string): string | undefined {
  const t = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (t.length === 0) return undefined
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('~')) return undefined
  if (/\.exe\b/i.test(t) || /^(Windows PowerShell|PowerShell|Command Prompt|Administrator|MINGW|bash|zsh|sh|cmd)\b/i.test(t)) return undefined
  if (/^Claude Code$/i.test(t)) return cwd.length > 0 ? `Claude · ${baseName(cwd)}` : 'Claude'
  return t.length > 60 ? `${t.slice(0, 59)}…` : t
}

/** The name shown everywhere: the user's, else the program's, else the default. */
export function displayName(win: WinState): string {
  if (win.nameManual === true) return win.title
  const rt = runtimes.get(win.id)
  const live = rt === undefined ? undefined : cleanTitle(rt.title, win.cwd)
  return live ?? win.autoName ?? win.title
}

/** Next z-order value; renumbers the stack when it gets large so it stays small and bounded. */
function nextZ(): number {
  if (store.zTop > 4000) {
    const ordered = [...store.wins].sort((a, b) => a.z - b.z)
    const rank = new Map(ordered.map((w, i) => [w.id, i + 1]))
    store.wins = store.wins.map((w) => ({ ...w, z: rank.get(w.id) ?? 1 }))
    store.zTop = ordered.length
  }
  return ++store.zTop
}

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

/** Patch one window. */
export function updateWin(id: string, patch: Partial<WinState>): void {
  store.wins = store.wins.map((w) => (w.id === id ? { ...w, ...patch } : w))
  emit()
  persistSoon()
}

/** Rename; an empty name hands control back to the program-derived name. */
export function renameWin(id: string, name: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0) updateWin(id, { nameManual: false })
  else updateWin(id, { title: trimmed, nameManual: true })
}

/** Raise a window above the others, give it focus and clear its attention flag. */
export function focusWin(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  const rt = runtimes.get(id)
  let changed = false
  if (rt !== undefined && rt.attention) {
    rt.attention = false
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

// ── preferences: folders, font, layouts, sidebar ───────────────────────────

/** Remember a folder as recent and as the next default. */
export function noteFolder(cwd: string, shell?: string): void {
  if (cwd.length === 0) return
  prefs.lastCwd = cwd
  if (shell !== undefined) prefs.lastShell = shell
  prefs.recents = [cwd, ...prefs.recents.filter((p) => p !== cwd)].slice(0, 12)
}

export function toggleFavourite(cwd: string): void {
  if (cwd.length === 0) return
  prefs.favourites = prefs.favourites.includes(cwd) ? prefs.favourites.filter((p) => p !== cwd) : [...prefs.favourites, cwd]
  emit()
  persistSoon()
}

export function forgetRecent(cwd: string): void {
  prefs.recents = prefs.recents.filter((p) => p !== cwd)
  emit()
  persistSoon()
}

export function setSidebar(open: boolean): void {
  prefs.sidebar = open
  emit()
  persistSoon()
}

export function setNotify(on: boolean): void {
  prefs.notify = on
  emit()
  persistSoon()
}

/** Apply font preferences to every live terminal and refit them. */
export function setFont(patch: Partial<FontPrefs>): void {
  const next = { ...prefs.font, ...patch }
  next.size = Math.min(32, Math.max(8, Number(next.size) || DEFAULT_FONT.size))
  next.lineHeight = Math.min(2, Math.max(1, Number(next.lineHeight) || DEFAULT_FONT.lineHeight))
  if (next.family.trim().length === 0) next.family = DEFAULT_FONT.family
  prefs.font = next
  prefs.fontCustom = true
  for (const rt of runtimes.values()) {
    rt.term.options.fontFamily = next.family
    rt.term.options.lineHeight = next.lineHeight
    refit(rt)
  }
  emit()
  persistSoon()
}

/** Terminal background colour, so the window chrome around it can match instead of showing app-coloured margins. */
export function termBackground(): string {
  return termTheme().background ?? '#14161b'
}

export function setTermTheme(mode: 'dark' | 'light' | 'auto'): void {
  prefs.termTheme = mode
  for (const rt of runtimes.values()) rt.term.options.theme = termTheme()
  emit()
  persistSoon()
}

export function setAutoFont(on: boolean): void {
  prefs.autoFont = on
  for (const rt of runtimes.values()) refit(rt)
  emit()
  persistSoon()
}

export function setFitCols(cols: number): void {
  prefs.fitCols = Math.min(240, Math.max(40, Math.round(cols) || 100))
  for (const rt of runtimes.values()) refit(rt)
  emit()
  persistSoon()
}

function snapshotWins(): LayoutWin[] {
  return store.wins.map((w) => {
    const g = w.maximized && w.restore !== undefined ? w.restore : w
    return {
      title: displayName(w),
      nameManual: true,
      shell: w.shell,
      cwd: w.cwd,
      startup: w.startup,
      x: g.x,
      y: g.y,
      w: g.w,
      h: g.h,
      pinned: w.pinned,
      minimized: w.minimized,
    }
  })
}

/** Save (or overwrite) the open windows as a named layout. */
export function saveLayout(name: string): void {
  const trimmed = name.trim()
  if (trimmed.length === 0 || store.wins.length === 0) return
  const entry: SavedLayout = { name: trimmed, savedAt: Date.now(), wins: snapshotWins() }
  prefs.layouts = [...prefs.layouts.filter((l) => l.name !== trimmed), entry]
  emit()
  persistSoon()
}

export function deleteLayout(name: string): void {
  prefs.layouts = prefs.layouts.filter((l) => l.name !== name)
  emit()
  persistSoon()
}

/** Open every window of a saved layout (spawning fresh shells and running startup commands). */
export function loadLayout(name: string): void {
  const layout = prefs.layouts.find((l) => l.name === name)
  if (layout === undefined) return
  for (const w of layout.wins) {
    openTerminal({
      title: w.title,
      nameManual: w.nameManual ?? true,
      shell: w.shell,
      cwd: w.cwd,
      startup: w.startup,
      rect: { x: w.x, y: w.y, w: w.w, h: w.h },
      pinned: w.pinned,
      minimized: w.minimized,
    })
  }
}

// ── broadcast ──────────────────────────────────────────────────────────────

export function setBroadcast(patch: Partial<{ on: boolean; live: boolean }>): void {
  store.broadcast = { ...store.broadcast, ...patch, ids: store.broadcast.ids }
  if (patch.on === true && store.broadcast.ids.size === 0) for (const w of store.wins) store.broadcast.ids.add(w.id)
  emit()
}

export function toggleBroadcastTarget(id: string): void {
  if (store.broadcast.ids.has(id)) store.broadcast.ids.delete(id)
  else store.broadcast.ids.add(id)
  emit()
}

export function setBroadcastTargets(ids: string[]): void {
  store.broadcast.ids = new Set(ids)
  emit()
}

/** Type one command line into every selected terminal. Returns how many received it. */
export function broadcastLine(text: string): number {
  let sent = 0
  for (const id of store.broadcast.ids) {
    const rt = runtimes.get(id)
    if (rt?.socket?.readyState === WebSocket.OPEN) {
      rt.lastInputAt = Date.now()
      rt.socket.send(JSON.stringify({ type: 'input', data: `${text}\r` }))
      sent++
    }
  }
  return sent
}

// ── activity, attention, notifications ─────────────────────────────────────

/** A window is "unattended" when the user cannot currently see/notice it. */
let viewMounts = 0
export function setViewMounted(mounted: boolean): void {
  viewMounts = Math.max(0, viewMounts + (mounted ? 1 : -1))
}
function unattended(id: string): boolean {
  if (typeof document === 'undefined') return true
  return !(document.hasFocus() && viewMounts > 0 && store.focusId === id)
}

function notify(win: WinState, rt: Runtime, body: string): void {
  if (!prefs.notify || typeof Notification === 'undefined') return
  // Only interrupt when the app is in the background or the Terminals tab is not on screen.
  if (document.hasFocus() && viewMounts > 0) return
  try {
    if (Notification.permission === 'default') Notification.requestPermission().catch(() => {})
    if (Notification.permission !== 'granted') return
    const n = new Notification(displayName(win), { body, tag: `wt-${rt.id}` })
    n.onclick = () => {
      window.focus()
      focusWin(rt.id)
    }
  } catch {}
}

function raiseAttention(rt: Runtime, reason: string): void {
  const win = store.wins.find((w) => w.id === rt.id)
  if (win === undefined || !unattended(rt.id)) return
  rt.attention = true
  rt.attentionReason = reason
  notify(win, rt, reason)
}

const WORK_QUIET_MS = 2500
const ECHO_GUARD_MS = 450
const MIN_WORK_MS = 3000

/** Derive the activity of one runtime from output recency, title glyph and host busy flag. */
function computeActivity(rt: Runtime, now: number): Activity {
  if (rt.conn === 'exited') return 'exited'
  if (rt.conn !== 'live') return 'offline'
  const spinning = /^[⠀-⣿]/.test(rt.title)
  const recentOutput = now - rt.lastOutputAt < WORK_QUIET_MS && now - rt.lastInputAt > ECHO_GUARD_MS
  if (spinning || recentOutput) return 'working'
  if (rt.hostBusy === true || rt.title.startsWith('✳')) return 'waiting'
  return 'idle'
}

function tick(): void {
  const now = Date.now()
  let changed = false
  for (const rt of runtimes.values()) {
    const next = computeActivity(rt, now)
    if (next === rt.activity) continue
    const prev = rt.activity
    rt.activity = next
    changed = true
    if (next === 'working') rt.workStart = now
    else if (prev === 'working' && now - rt.workStart >= MIN_WORK_MS) {
      raiseAttention(rt, next === 'exited' ? 'The process exited' : next === 'waiting' ? 'Finished — waiting for you' : 'Finished')
    } else if (next === 'exited' && prev !== 'exited') {
      raiseAttention(rt, 'The process exited')
    }
  }
  if (changed) emit()
}
let ticker: ReturnType<typeof setInterval> | undefined

// ── terminal runtimes ──────────────────────────────────────────────────────

/** Relative luminance (0..1) of a computed CSS colour string, or undefined when it is transparent/unparseable. */
export function luminanceOf(color: string): number | undefined {
  const viaCanvas = (): number | undefined => {
    try {
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx === null || color.length === 0 || color === 'transparent') return undefined
      ctx.fillStyle = '#000'
      ctx.fillStyle = color
      const resolved = ctx.fillStyle
      return resolved.startsWith('rgb') && resolved !== color ? luminanceOf(resolved) : undefined
    } catch {
      return undefined
    }
  }
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(color)
  if (m === null) return viaCanvas()
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4])
  if (alpha < 0.5) return undefined
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number.parseFloat(v as string) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Whether the app currently paints a dark surface. Measured from the real background
 * (the theme's tokens can disagree with `color-scheme`), falling back to the declared scheme.
 * @param element - element whose own/ancestor background to sample; defaults to the body.
 */
export function isDarkSurface(element?: Element): boolean {
  if (typeof document === 'undefined') return true
  // The harness publishes its resolved scheme explicitly (theme presenter): authoritative when present.
  if (document.documentElement.hasAttribute('data-ds-theme-source') || document.body.hasAttribute('data-ds-dark-theme')) {
    return document.body.hasAttribute('data-ds-dark-theme')
  }
  for (let el: Element | null = element ?? document.body; el !== null; el = el.parentElement) {
    const lum = luminanceOf(getComputedStyle(el).backgroundColor)
    if (lum !== undefined) return lum < 0.5
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme
  return scheme.length > 0 ? scheme.includes('dark') : window.matchMedia?.('(prefers-color-scheme: dark)').matches !== false
}

// ── find in terminal ───────────────────────────────────────────────────────

export interface FindOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

const FIND_DECORATIONS = {
  matchBackground: '#6b5c1f',
  matchBorder: '#9c8a2e',
  matchOverviewRuler: '#d1b84a',
  activeMatchBackground: '#c9a227',
  activeMatchBorder: '#ffd75e',
  activeMatchColorOverviewRuler: '#ffd75e',
}

/** Open the find bar on a terminal (Ctrl+F). */
export function openSearch(id: string): void {
  store.searchId = id
  emit()
}

/** Close the find bar, drop highlights and hand focus back to the terminal. */
export function closeSearch(): void {
  const rt = store.searchId === null ? undefined : runtimes.get(store.searchId)
  store.searchId = null
  if (rt !== undefined) {
    rt.search.clearDecorations()
    rt.searchIndex = 0
    rt.searchCount = 0
    rt.term.focus()
  }
  emit()
}

/**
 * Find the next/previous match of `query` in a terminal's buffer.
 * @param incremental - true while typing, so the current match stays put when it still matches.
 */
export function runSearch(id: string, query: string, options: FindOptions, direction: 'next' | 'prev', incremental = false): void {
  const rt = runtimes.get(id)
  if (rt === undefined) return
  if (query.length === 0) {
    rt.search.clearDecorations()
    rt.searchIndex = 0
    rt.searchCount = 0
    emit()
    return
  }
  const opts = { ...options, incremental, decorations: FIND_DECORATIONS }
  try {
    if (direction === 'next') rt.search.findNext(query, opts)
    else rt.search.findPrevious(query, opts)
  } catch {
    // An invalid regular expression simply finds nothing.
    rt.searchIndex = 0
    rt.searchCount = 0
    emit()
  }
}

/** xterm colours (VS Code Dark+/Light+ ANSI palettes) following the app's scheme at creation time. */
function termTheme(): Record<string, string> {
  const dark = prefs.termTheme === 'auto' ? isDarkSurface() : prefs.termTheme === 'dark'
  return dark
    ? {
        background: '#14161b', foreground: '#d4d4d4', cursor: '#7c93ff', cursorAccent: '#14161b', selectionBackground: '#3b4a8a99',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
      }
    : {
        background: '#ffffff', foreground: '#1f2328', cursor: '#4d6bfe', cursorAccent: '#ffffff', selectionBackground: '#4d6bfe33',
        black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
        brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
      }
}

function setConn(rt: Runtime, conn: Conn, detail = ''): void {
  rt.conn = conn
  rt.detail = detail
  tick()
  emit()
}

/**
 * WebSocket origin for the host. The desktop app serves the page from a custom
 * `dsh-app://app` scheme, so `location.host` is useless there: the app publishes the
 * real loopback origin as `__DSH_TRANSPORT__.streamBaseUrl` (its own stream client
 * does the same) and rewrites the upgrade's Origin/cookie for that address. In a
 * plain browser the page origin is the host.
 */
function socketBase(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
  const base = new URL(transport?.streamBaseUrl ?? window.location.href)
  return `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}`
}

/** Key combinations the app handles itself, so the terminal must not swallow them. */
function isAppShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
}

/** Build (once) the xterm + socket for a window. */
export function ensureRuntime(win: WinState): Runtime {
  const existing = runtimes.get(win.id)
  if (existing !== undefined) return existing

  const holder = document.createElement('div')
  holder.className = 'wt-holder'
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: prefs.font.family,
    fontSize: prefs.font.size,
    lineHeight: prefs.font.lineHeight,
    scrollback: 5000,
    allowProposedApi: true,
    // Keep text readable whatever colours a program prints (e.g. white text from a dark-themed TUI on a light background).
    minimumContrastRatio: 4.5,
    theme: termTheme(),
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  // Links open with Ctrl/Cmd+click (like VS Code) so plain clicks still select text.
  // The desktop app routes window.open of http(s) URLs to the system browser.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (!(event.ctrlKey || event.metaKey)) return
      window.open(uri, '_blank', 'noopener,noreferrer')
    }),
  )
  term.open(holder)

  const rt: Runtime = {
    id: win.id,
    holder,
    term,
    fit,
    search,
    searchIndex: 0,
    searchCount: 0,
    socket: null,
    conn: 'connecting',
    detail: '',
    title: '',
    killed: false,
    retry: 0,
    timer: undefined,
    lastCols: 0,
    lastRows: 0,
    activity: 'offline',
    hostBusy: undefined,
    lastOutputAt: 0,
    lastInputAt: 0,
    workStart: 0,
    attention: false,
    attentionReason: '',
  }
  runtimes.set(win.id, rt)
  ticker ??= setInterval(tick, 1000)

  term.onData((data) => {
    rt.lastInputAt = Date.now()
    if (rt.socket !== null && rt.socket.readyState === WebSocket.OPEN) rt.socket.send(JSON.stringify({ type: 'input', data }))
    // Live mirror: keystrokes typed here also go to the other selected terminals.
    if (store.broadcast.on && store.broadcast.live && store.broadcast.ids.has(rt.id)) {
      for (const id of store.broadcast.ids) {
        if (id === rt.id) continue
        const other = runtimes.get(id)
        if (other?.socket?.readyState === WebSocket.OPEN) {
          other.lastInputAt = Date.now()
          other.socket.send(JSON.stringify({ type: 'input', data }))
        }
      }
    }
  })
  term.onTitleChange((title) => {
    rt.title = title
    const w = store.wins.find((x) => x.id === rt.id)
    if (w !== undefined) {
      const name = cleanTitle(title, w.cwd)
      if (name !== undefined && name !== w.autoName) updateWin(rt.id, { autoName: name })
    }
    tick()
    emit()
  })
  term.onBell(() => raiseAttention(rt, 'Rang the terminal bell'))
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    rt.searchCount = resultCount
    rt.searchIndex = resultCount === 0 || resultIndex < 0 ? 0 : resultIndex + 1
    emit()
  })
  // Ctrl+C copies when there is a selection (otherwise it is SIGINT); Ctrl+Shift+C/V always copy/paste;
  // Ctrl+F opens the find bar.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (isAppShortcut(event)) return false
    const mod = event.ctrlKey || event.metaKey
    if (mod && !event.shiftKey && !event.altKey && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault()
      openSearch(rt.id)
      return false
    }
    if (mod && (event.key === 'c' || event.key === 'C') && (event.shiftKey || term.hasSelection())) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {})
      return false
    }
    if (mod && event.shiftKey && (event.key === 'v' || event.key === 'V')) {
      navigator.clipboard?.readText().then((text) => term.paste(text)).catch(() => {})
      return false
    }
    return true
  })

  const connect = () => {
    if (rt.killed) return
    const current = store.wins.find((w) => w.id === rt.id)
    if (current === undefined) return
    const dims = rt.fit.proposeDimensions()
    const params = new URLSearchParams({ id: `${rt.id}-${current.gen ?? 0}`, shell: current.shell })
    if (current.cwd.length > 0) params.set('cwd', current.cwd)
    if (dims !== undefined && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      params.set('cols', String(dims.cols))
      params.set('rows', String(dims.rows))
    }
    const socket = new WebSocket(`${socketBase()}/terminal/ws?${params.toString()}`)
    rt.socket = socket
    setConn(rt, 'connecting')

    socket.onmessage = (event) => {
      let frame: { type: string; data?: string; replay?: string; created?: boolean; exited?: boolean; exitCode?: number | null; message?: string; busy?: boolean }
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.type === 'attached') {
        rt.retry = 0
        term.reset()
        if ((frame.replay ?? '').length > 0) term.write(frame.replay as string)
        if (frame.exited === true) {
          setConn(rt, 'exited', `exit ${frame.exitCode ?? 'signal'}`)
        } else {
          setConn(rt, 'live')
          rt.lastCols = 0
          sizeToHost(rt)
          const startup = store.wins.find((w) => w.id === rt.id)?.startup
          if (frame.created === true && startup !== undefined && startup.trim().length > 0) {
            setTimeout(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: `${startup}\r` }))
            }, 500)
          }
        }
      } else if (frame.type === 'data') {
        rt.lastOutputAt = Date.now()
        term.write(frame.data ?? '')
      } else if (frame.type === 'activity') {
        rt.hostBusy = frame.busy === true
        tick()
        emit()
      } else if (frame.type === 'exit') {
        setConn(rt, 'exited', `exit ${frame.exitCode ?? 'signal'}`)
        term.write('\r\n\x1b[2m[process exited — close or restart this window]\x1b[0m\r\n')
      } else if (frame.type === 'error') {
        setConn(rt, 'failed', frame.message ?? 'error')
        term.write(`\x1b[31m${frame.message ?? 'error'}\x1b[0m\r\n`)
      }
    }
    socket.onclose = (event) => {
      if (rt.socket !== socket || rt.killed) return
      if (rt.conn === 'exited' || rt.conn === 'failed') return
      if (event.code === 4000) return setConn(rt, 'lost', 'opened in another tab')
      if (event.code === 1013) return setConn(rt, 'failed', 'too many terminals')
      setConn(rt, 'lost', 'reconnecting…')
      const delay = Math.min(8000, 700 * 2 ** rt.retry++)
      rt.timer = setTimeout(connect, delay)
    }
  }
  // Let the holder attach and fit once before the first connect so the PTY starts at the right size.
  requestAnimationFrame(() => {
    try {
      fit.fit()
    } catch {}
    connect()
  })
  return rt
}

/** Push the current xterm grid size to the PTY when it changed. */
export function sizeToHost(rt: Runtime): void {
  const { cols, rows } = rt.term
  if (cols === rt.lastCols && rows === rt.lastRows) return
  rt.lastCols = cols
  rt.lastRows = rows
  if (rt.socket !== null && rt.socket.readyState === WebSocket.OPEN) {
    rt.socket.send(JSON.stringify({ type: 'resize', cols, rows }))
  }
}

/** Refit a runtime to its container and tell the host. */
/**
 * Font size for a window: the user's size, shrunk only as far as needed to keep about
 * `fitCols` columns visible (monospace glyphs are roughly 0.6 em wide), never below 9 px.
 */
function effectiveFontSize(widthPx: number): number {
  const base = prefs.font.size
  if (!prefs.autoFont) return base
  const fitting = Math.floor(widthPx / (prefs.fitCols * 0.6))
  return Math.max(Math.min(9, base), Math.min(base, fitting))
}

/** Refit a runtime to its container (adapting the font size to its width) and tell the host. */
export function refit(rt: Runtime): void {
  if (!rt.holder.isConnected || rt.holder.clientWidth < 20 || rt.holder.clientHeight < 20) return
  const size = effectiveFontSize(rt.holder.clientWidth)
  if (rt.term.options.fontSize !== size) rt.term.options.fontSize = size
  try {
    rt.fit.fit()
  } catch {
    return
  }
  sizeToHost(rt)
}

/** Kill the shell and start a fresh one (same folder, startup command re-runs). */
export function restartWin(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  disposeRuntime(id, true)
  updateWin(id, { gen: (win.gen ?? 0) + 1 })
}

/** Plain-text copy of a terminal's buffer (scrollback included). */
export function bufferText(id: string): string {
  const rt = runtimes.get(id)
  if (rt === undefined) return ''
  const buffer = rt.term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return lines.join('\n').replace(/\s+$/, '')
}

/** Download a terminal's text as a log file. */
export function saveLog(id: string): void {
  const win = store.wins.find((w) => w.id === id)
  if (win === undefined) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safe = displayName(win).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'terminal'
  const url = URL.createObjectURL(new Blob([bufferText(id)], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${safe}-${stamp}.log`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function disposeRuntime(id: string, kill: boolean): void {
  const rt = runtimes.get(id)
  if (rt === undefined) return
  rt.killed = true
  if (rt.timer !== undefined) clearTimeout(rt.timer)
  try {
    if (kill && rt.socket?.readyState === WebSocket.OPEN) rt.socket.send(JSON.stringify({ type: 'kill' }))
    rt.socket?.close()
  } catch {}
  try {
    rt.term.dispose()
  } catch {}
  rt.holder.remove()
  runtimes.delete(id)
}
