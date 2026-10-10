// dsh-web-terminal — shared client types.

import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { SubagentInfo } from './subagents.ts'
import type { BlockModel } from './blocks.ts'
import type { EditInfo } from './edits-api.ts'

/** Rectangle in canvas fractions (0..1). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where an SSH window connects. Only what `ssh` needs to be started again: an alias from ~/.ssh/config or
 * `[user@]host`, a port and a remote command. Never a password, key or passphrase: ssh asks for those in the terminal.
 */
export interface SshTarget {
  /** A ~/.ssh/config alias. */
  host?: string
  /** `[user@]host`, IPv6 in brackets. Exactly one of `host` and `target` is set. */
  target?: string
  port?: number
  /** Runs on the remote machine instead of its login shell's prompt. */
  command?: string
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
  /** Set for an SSH window (then `shell` is `ssh` and `cwd` is empty: it is a folder on this machine). */
  ssh?: SshTarget
  z: number
  pinned: boolean
  maximized: boolean
  minimized: boolean
  /** Geometry to return to when un-maximized. */
  restore?: Rect
  /** Bumped on restart so the host never confuses a new shell with the one being killed. */
  gen?: number
  /** Latest conversation id the agent in this window reported; a fresh shell resumes it. */
  agentSession?: string
  /** Last real grid size (after a fit); a terminal created before its page opens starts at this size. */
  cols?: number
  rows?: number
}

/** Connection phase of one terminal runtime. */
export type Conn = 'connecting' | 'live' | 'exited' | 'lost' | 'failed'

/** What the terminal is doing right now, for the status dot and list. */
export type Activity = 'working' | 'needs-you' | 'finished' | 'running' | 'idle' | 'exited' | 'offline' | 'connected' | 'disconnected'

/** What an agent reports about itself (see lib/agent-signals.js on the host). */
export type AgentState = 'idle' | 'working' | 'needs-you' | 'finished' | 'failed' | 'ended'

/** One agent signal as it arrives from the host. */
export interface AgentSignal {
  provider: string
  state: AgentState
  detail: string
  /** Host time the signal arrived (ms). */
  at?: number
  /** The agent's conversation id, when it reported a safe one. */
  session?: string
}

/** The latest signal an agent sent, kept on the runtime. */
export interface AgentInfo {
  provider: string
  state: AgentState
  detail: string
  /** When the agent entered this state (ms). */
  since: number
}

/** How hard a terminal asks for the user: urgent interrupts, quiet only marks. */
export type AttentionLevel = 'urgent' | 'quiet'

/** Live (non-serializable) side of one terminal window. */
export interface Runtime {
  id: string
  holder: HTMLDivElement
  /** xterm has been opened into the holder (it is created unopened so terminals connect before the page exists). */
  opened: boolean
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Current find result (1-based index, 0 when none) and total matches. */
  searchIndex: number
  searchCount: number
  socket: WebSocket | null
  /** An SSH window: the local process is always `ssh`, so its dot says connected / disconnected instead. */
  ssh: boolean
  /** Exit code of the local process once it ended (255 from ssh = the connection was lost or never made). */
  exitCode?: number | null
  conn: Conn
  detail: string
  /** Raw OSC title the program set. */
  title: string
  killed: boolean
  retry: number
  /** The host has attached this terminal at least once in this page lifetime (a reload resets it). */
  attachedOnce: boolean
  /** The host lost this terminal's shell (restart); the shell it spawned for the reconnect was killed. */
  hostLost: boolean
  /** Bytes handed to xterm whose write has not been parsed yet. */
  pendingBytes: number
  /** Output was dropped while `pendingBytes` was over the limit. */
  droppedOutput: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  /** Cancels the pending startup-command typing (socket closed, terminal disposed). */
  stopStartup?: () => void
  lastCols: number
  lastRows: number
  activity: Activity
  /** Host says a child process runs under the shell; undefined = unknown. */
  hostBusy: boolean | undefined
  lastOutputAt: number
  lastInputAt: number
  /** When the startup command was typed into the shell (undefined until it is). */
  startupSentAt?: number
  /** What the agent in this terminal last reported; undefined for a plain shell. */
  agent: AgentInfo | undefined
  /** Claude sub-agents the host reports for this terminal (running, plus recently completed). */
  subagents: SubagentInfo[]
  /** Files this terminal's agent changed (the host's `edits` list). */
  edits: EditInfo[]
  /** The "may be stuck" alert already fired for the current working spell. */
  hungRaised: boolean
  /** Needs the user's eyes: an agent is blocked, failed or finished, or the shell exited, while unattended. */
  attention: boolean
  attentionLevel: AttentionLevel | null
  /** Short badge text and the longer tooltip/notification text. */
  attentionLabel: string
  attentionReason: string
  // ── command blocks (blocks.ts) ──
  /** Command blocks cut by the shell integration; created with the runtime. */
  blocks?: BlockModel
  /** The shell's real current folder, once it reports one (OSC 633;P / OSC 7). */
  cwd?: string
  /** Hover header and sticky bar (block-bar.ts); exists once the terminal is opened. */
  blockBar?: { refresh(): void; dispose(): void }
  // ── end command blocks ──
}

/** Font preferences shared by every terminal. */
export interface FontPrefs {
  family: string
  size: number
  lineHeight: number
  /** Extra pixels between cells; xterm rounds it to whole pixels. */
  letterSpacing: number
  /** CSS weight of bold text (the regular weight stays 400). */
  boldWeight: number
  /** xterm minimumContrastRatio: text below this contrast against its background is lifted (1 = off). */
  minContrast: number
}

/** One window inside a saved layout. */
export type LayoutWin = Pick<WinState, 'title' | 'nameManual' | 'shell' | 'cwd' | 'startup' | 'ssh' | 'x' | 'y' | 'w' | 'h' | 'pinned' | 'minimized'>

export interface SavedLayout {
  name: string
  savedAt: number
  wins: LayoutWin[]
}

/** Host probe results shared with the view. */
export interface HostInfo {
  /** Plugin version from the host's package.json (null when it could not be read). */
  version?: string | null
  platform?: string
  shell?: string
  shells?: { id: string; label: string }[]
  cwd?: string
  claude?: { available?: boolean; path?: string | null }
  /** `node` on the host's PATH; the status-line wrapper needs it. */
  node?: { available?: boolean; path?: string | null }
  /** The `ssh` client on the host's PATH and the concrete aliases in its ~/.ssh/config. */
  ssh?: { available?: boolean; path?: string | null; hosts?: SshHost[] }
  maxSessions?: number
  /** Files the host generated for agents; claudeSettings is null when it could not write one. */
  agent?: { claudeSettings?: string | null }
}

/** One alias from ~/.ssh/config, for display. */
export interface SshHost {
  alias: string
  hostName: string | null
  user: string | null
  port: number | null
}

/** Where a Ctrl+clicked file path opens. `code` is the sibling Code editor plugin (an in-app event, no host call). */
export type PathTarget = 'code' | 'vscode' | 'cursor' | 'default' | 'custom'

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
  /** SSH targets used before (newest first, at most 10) and the starred ones. Targets only, never credentials. */
  sshRecents: SshTarget[]
  sshFavourites: SshTarget[]
  layouts: SavedLayout[]
  lastShell: string
  lastCwd: string
  /** Folder of the chat session viewed last (recorded by the header bar); fallback when the harness lists no Workspaces. */
  sessionCwd: string
  sidebar: boolean
  /** The sub-agents panel on the Terminals page. */
  agentsPanel: boolean
  notify: boolean
  /** Play a chime for urgent alerts. */
  sound: boolean
  /** Minutes without output or signals before a working agent is flagged as stuck; 0 turns it off. */
  hungMinutes: number
  /** Editor for Ctrl+clicked file paths, and the command template when it is `custom`. */
  pathTarget: PathTarget
  pathTemplate: string
  /** Inject shell integration (command blocks, real cwd) into newly started shells. */
  shellIntegration: boolean
  /** Frame text sent to an agent terminal as a fenced code block. */
  sendCodeBlock: boolean
  /** A command that ran at least this many seconds raises a done / failed flag when the terminal is unattended; 0 = never. */
  commandNotifySec: number
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
