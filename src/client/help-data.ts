// dsh-web-terminal — the help panel's content that is not a keyboard shortcut (see shortcuts.ts):
// mouse actions, legends and the diagnostics report. Plain data and pure functions, so the
// panel (help-panel.tsx) stays layout only and the tests can load this file without a DOM.

import { formatAge, formatClock } from './stats-format.ts'
import type { Activity, Conn } from './types.ts'

/** What each status dot means. The windows, the list and the help legend all read this one table. */
export const ACTIVITY_TITLE: Record<Activity, string> = {
  working: 'Working — the agent is on a turn',
  'needs-you': 'Needs you — the agent is blocked on a permission, a question or an error',
  finished: 'Finished — the agent is waiting for your next prompt',
  running: 'Running — a program is running in the shell',
  idle: 'Idle — nothing is running',
  exited: 'The process exited',
  offline: 'Not connected',
  connected: 'Connected — the ssh session is up (ssh windows only)',
  disconnected: 'Disconnected — the ssh connection was lost or could not be made; use Reconnect (ssh windows only)',
}

export const ACTIVITY_ORDER: readonly Activity[] = ['working', 'needs-you', 'finished', 'running', 'idle', 'exited', 'offline', 'connected', 'disconnected']

export interface MouseAction {
  how: string
  what: string
}

/** Each entry is checked against the code that handles it (terminals-view.tsx, sidebar.tsx, send-to.ts, runtime.ts, path-links.ts, ...). */
export const MOUSE_ACTIONS: readonly MouseAction[] = [
  { how: 'Click a window\'s name', what: 'Rename it (Enter saves, Esc cancels, empty = automatic name)' },
  { how: 'Double-click the title bar', what: 'Maximize / restore (not while pinned)' },
  { how: 'Drag the title bar', what: 'Move the window; its edges snap to the canvas and to other windows' },
  { how: 'Drag a window to an edge', what: 'Snap: top = maximize, left / right = half, bottom = half, corner = quarter' },
  { how: 'Drag a maximized title bar', what: 'Restore the previous size under the pointer' },
  { how: 'Drag an edge or corner', what: 'Resize (not while pinned or maximized)' },
  { how: 'Ctrl+click a link or file path', what: 'Open it: links in the browser, paths in the editor chosen in Aa (Cmd+click on macOS)' },
  { how: 'Right-click a selection', what: 'Send menu: copy, another terminal, or a new Claude terminal' },
  { how: 'Shift+right-click a selection', what: 'The same inside programs that use the mouse (they get plain right-clicks)' },
  { how: 'Shift+drag in the terminal', what: 'Select text inside programs that use the mouse (Windows / Linux)' },
  { how: 'Click "↓ N new lines"', what: 'Jump to where you left off' },
  { how: 'Click a terminal in the list', what: 'Focus it; drag to reorder, double-click the name to rename, hover for duplicate / close' },
  { how: 'Click a minimized chip', what: 'Restore that window (chips are in the toolbar)' },
  { how: 'Click a tile in the overview', what: 'Open that terminal' },
]

/** What the ⇄ SSH tab does and where it stops (README: SSH terminals). Each line is checked against new-dialog.tsx / runtime.ts / path-links.ts. */
export const SSH_HELP: readonly MouseAction[] = [
  { how: '⇄ SSH button, or New terminal → ⇄ SSH', what: 'Pick a host from ~/.ssh/config, type user@host[:port], or reuse a recent target (★ keeps it); "Run on connect" runs a command on the remote machine' },
  { how: 'Keys and passwords', what: 'The system ssh client does the login. A password or key passphrase is typed in the terminal; the plugin stores no secrets, only the host, port and command' },
  { how: 'Dot: Connected / Disconnected', what: 'Connected while the ssh session is up. Disconnected (ssh exit 255) means the link dropped or was never made: click Reconnect. There is no automatic retry' },
  { how: 'Other exit codes', what: 'The remote session ended normally (Exited); ↻ starts a new connection' },
  { how: 'Not available over ssh yet', what: 'Ctrl+click on file paths (they live on the remote machine), Claude status and agent badges' },
]

export interface AttentionLegend {
  level: 'urgent' | 'quiet'
  badge: string
  what: string
}

/** Badge texts come from attention.ts (alertFor, exitAlert, hostRestartAlert, hungAlert, the bell). */
export const ATTENTION_LEGEND: readonly AttentionLegend[] = [
  { level: 'urgent', badge: 'needs you', what: 'Urgent: blocked on a permission or question; also failed, stuck?, or exited / host restarted mid-task. Orange glow, a chime (if sound is on) and a notification, unless you are looking at it.' },
  { level: 'quiet', badge: 'finished', what: 'Quiet: a turn ended, the bell rang, or a shell exited cleanly. Yellow badge; a notification only when the app is in the background.' },
]

export interface GutterLegend {
  state: 'ok' | 'fail' | 'run' | 'unk'
  what: string
}

/** Colours are the `.wt-gutter` rules in blocks.css.ts; PowerShell and bash only, with shell integration on. */
export const GUTTER_LEGEND: readonly GutterLegend[] = [
  { state: 'ok', what: 'Command succeeded (exit 0)' },
  { state: 'fail', what: 'Command failed (non-zero exit)' },
  { state: 'run', what: 'Command still running' },
  { state: 'unk', what: 'Finished, exit code unknown' },
]

export interface StatsLegendItem {
  term: string
  what: string
}

/** Mirrors stats-bar.tsx / stats-format.ts and the forecast in lib/usage.js. */
export const STATS_LEGEND: readonly StatsLegendItem[] = [
  { term: '5h 42% · resets 17:30', what: 'Share used of the 5-hour limit and the clock time it resets.' },
  { term: '7d 63%', what: 'Share used of the weekly limit; hover for its reset day and time.' },
  { term: 'out ~HH:mm', what: 'When the limit would hit 100% at the current pace. 5h: pace of the last 60 minutes; 7d: pace of the last 24 hours (7d adds the weekday). Hidden when it would not run out before the reset.' },
  { term: 'yellow > 50 %, red > 75 %', what: 'The percentage changes colour as you use more of a limit.' },
  { term: 'dimmed, "12m ago"', what: 'The numbers are older than 10 minutes: they come from the last Claude terminal that reported.' },
  { term: 'limits n/a', what: 'Limit tracking is off; Diagnostics below says why.' },
  { term: '$12.34', what: 'Cost at API prices for the usage in your open Claude terminals (not what a subscription bills).' },
  { term: '2.5B tok', what: 'All-time tokens processed, cache reads included; hover for the input / output / cache split.' },
  { term: '3 agents', what: 'Claude sub-agents running right now, across all terminals.' },
  { term: '● 2 working', what: 'Terminals by agent status (working, needs you, finished).' },
]

// ── diagnostics ──

export interface ConnCounts {
  live: number
  connecting: number
  /** Lost the connection or failed to start. */
  offline: number
  /** The shell ended (not an error: the host still knows the terminal). */
  exited: number
}

export function countConns(conns: Iterable<Conn>): ConnCounts {
  const out: ConnCounts = { live: 0, connecting: 0, offline: 0, exited: 0 }
  for (const c of conns) {
    if (c === 'live') out.live++
    else if (c === 'connecting') out.connecting++
    else if (c === 'exited') out.exited++
    else out.offline++
  }
  return out
}

export interface DiagnosticsInput {
  version: string | null | undefined
  platform: string | undefined
  node: { available?: boolean; path?: string | null } | undefined
  claude: { available?: boolean; path?: string | null } | undefined
  /** The ssh client and how many hosts ~/.ssh/config lists; undefined for a host that predates ssh support. */
  ssh: { available?: boolean; path?: string | null; hosts?: unknown[] } | undefined
  /** From /stats; undefined until the first answer. */
  statusLine: { enabled: boolean; reason: string | null } | undefined
  /** The "mark commands" preference. */
  shellIntegration: boolean
  /** The focused terminal and whether the shell sent integration markers; null when none is focused. */
  focused: { name: string; markersSeen: boolean } | null
  conns: ConnCounts
  /** When the limits were last reported by a Claude terminal. */
  sampledAt: number | null | undefined
  now: number
}

/** One probe result as `found (path)` / `not found`, or `unknown` while the host has not answered. */
function found(probe: { available?: boolean; path?: string | null } | undefined): string {
  if (probe === undefined || probe.available === undefined) return 'unknown (host has not answered)'
  return probe.available ? `found${probe.path ? ` (${probe.path})` : ''}` : 'not found'
}

export interface DiagnosticRow {
  label: string
  value: string
  /** Something to fix or look at. */
  bad?: boolean
}

/** The report as label / value rows, for the panel and for the plain-text copy. */
export function diagnosticRows(d: DiagnosticsInput): DiagnosticRow[] {
  const age = d.sampledAt == null ? 'no sample yet' : `${formatAge(d.now - d.sampledAt)} (${formatClock(d.sampledAt)})`
  const wrapper = d.statusLine === undefined ? 'unknown (no stats answer yet)' : d.statusLine.enabled ? 'enabled' : `off: ${d.statusLine.reason ?? 'unknown reason'}`
  const markers = d.focused === null ? 'no terminal focused' : `${d.focused.markersSeen ? 'markers seen' : 'no markers yet'} in "${d.focused.name}"`
  const c = d.conns
  return [
    { label: 'Plugin version', value: d.version ?? 'unknown' },
    { label: 'Platform', value: d.platform ?? 'unknown' },
    { label: 'node', value: found(d.node), bad: d.node?.available === false },
    { label: 'claude', value: found(d.claude), bad: d.claude?.available === false },
    { label: 'ssh', value: found(d.ssh) },
    { label: 'ssh config hosts', value: d.ssh?.hosts === undefined ? 'unknown (host has not answered)' : String(d.ssh.hosts.length) },
    { label: 'Status-line wrapper', value: wrapper, bad: d.statusLine?.enabled === false },
    { label: 'Shell integration', value: `${d.shellIntegration ? 'on' : 'off'} (setting); ${markers}` },
    { label: 'Terminals', value: `${c.live} live, ${c.connecting} connecting, ${c.offline} offline${c.exited > 0 ? `, ${c.exited} exited` : ''}`, bad: c.offline > 0 },
    { label: 'Stats sample', value: age },
  ]
}

/** Plain-text report for "Copy diagnostics". Holds no tokens or environment values: only versions, paths and states. */
export function buildDiagnostics(d: DiagnosticsInput): string {
  return ['DSH Web Terminal diagnostics', ...diagnosticRows(d).map((r) => `${r.label}: ${r.value}`)].join('\n')
}
