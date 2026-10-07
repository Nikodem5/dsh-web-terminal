// dsh-web-terminal — shared client types.

import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'

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

/** Persisted user preferences. */
export interface Prefs {
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

/** Everything the view reads; mutated in place, `version` bumps on change. */
export interface Store {
  wins: WinState[]
  zTop: number
  focusId: string | null
  /** Window whose find bar is open. */
  searchId: string | null
  version: number
  broadcast: { on: boolean; live: boolean; ids: Set<string> }
}
