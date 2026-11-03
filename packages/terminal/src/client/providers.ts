// dsh-web-terminal — agent providers (client half): what each kind of agent looks like in the UI and
// how its command is started. Claude Code is the first entry; a command that matches no provider is a
// plain shell command. The host half (lib/providers/) says which are installed and what to inject.

import { isSessionId } from './launch.ts'
import type { Runtime, WinState } from './types.ts'

/** What the host reports for one provider's launch (`launch` in the info route): opaque here, each provider reads its own. */
export type LaunchHint = Record<string, unknown> | null | undefined

export interface AgentProvider {
  /** Same id as the host's provider: the key in `hostInfo.providers`, the `provider` on its signals and in a saved window. */
  id: string
  /** Short product name: the toolbar button, the send menu and the window name ("Claude"). */
  label: string
  /** The mark in front of the label on buttons and menu items. */
  glyph: string
  /** CSS class of its toolbar button (its colour). */
  buttonClass: string
  /** The executable the host looks for on PATH. */
  command: string
  /** What the one-click button and "new terminal here" type into the shell. */
  startup: string
  /** Startup commands the New terminal dialog offers. */
  presets: string[]
  /** A saved startup command that starts this provider (first word, not a path to another tool). */
  matchStartup: RegExp
  /** Any command line that runs this provider, paths and extensions included (a shell command a user typed). */
  matchCommand: RegExp
  /** The title the program sets on its terminal; shown as "<label> · <folder>". */
  title: RegExp
  /**
   * The command to type for a saved startup command: with whatever the host prepared added
   * (a flag, say), and resuming the conversation when the terminal remembers one.
   * @param startup - the command saved with the terminal.
   * @param launch - the host's launch hint for this provider.
   * @param session - the conversation id this terminal's agent last reported, if any.
   * @param turned - the agent in this window has had at least one turn.
   */
  launch(startup: string, launch: LaunchHint, session?: string | null, turned?: boolean): string
  /** An `ended` signal carrying a conversation id names one that exists (the agent reported it on the way out), so it is remembered. */
  sessionOnEnd?: boolean
  /** Whether a terminal started with `startup` has its agent up and takes a paste (a send waits for it). */
  ready(rt: Runtime, now: number): boolean
}

// ── Claude Code ──

/** `claude` as the first word of a command (not `claude-code-router` or a path to another tool). */
const CLAUDE_COMMAND = /^(\s*)claude(?=\s|$)/

/** `--resume` or `--continue` with no conversation named: the interactive picker, or "the latest one". */
const BARE_RESUME = /(?<=\s)(?:--resume|-r|--continue|-c)(?=\s|$)(?!\s+[^\s-])/
/** Any flag that already chooses a conversation. */
const HAS_RESUME = /(?:^|\s)(?:--resume|-r|--continue|-c)(?:\s|=|$)/

/** Output must have been quiet this long, after the command was typed, before a send to a new Claude. */
const CLAUDE_SETTLE_MS = 800

/**
 * Make a Claude launch report to this plugin, and pick up where it left off.
 *
 * A startup command that starts `claude` gets `--settings <file>` inserted after it, so
 * Claude's own hooks tell the plugin when it works, needs you or finishes, without touching
 * the user's Claude configuration (`--settings` adds to it).
 *
 * When the terminal remembers a conversation, the fresh shell resumes it: a bare `--resume`
 * or `--continue` becomes `--resume <id>`, and a plain `claude` gets `--resume <id>` added.
 * A command that already names a conversation (`--resume <id>`) is left alone.
 *
 * Any other command, a command that already passes `--settings`, or a missing settings file
 * leaves that part unchanged. The path uses forward slashes and double quotes, which
 * PowerShell, cmd and bash all accept.
 */
function claudeLaunch(startup: string, launch: LaunchHint, session?: string | null): string {
  if (!CLAUDE_COMMAND.test(startup)) return startup
  let command = startup
  if (isSessionId(session)) {
    if (BARE_RESUME.test(command)) command = command.replace(BARE_RESUME, `--resume ${session}`)
    else if (!HAS_RESUME.test(command)) command = `${command.trimEnd()} --resume ${session}`
  }
  const settingsPath = launch?.settingsPath
  if (typeof settingsPath === 'string' && settingsPath.length > 0 && !/(^|\s)--settings(\s|=)/.test(command)) {
    const file = settingsPath.replace(/\\/g, '/')
    command = command.replace(CLAUDE_COMMAND, (_all, lead: string) => `${lead}claude --settings "${file}"`)
  }
  return command
}

/**
 * Claude is ready once its startup command has been typed, its screen has gone quiet and it switched
 * bracketed paste on (it does so when its prompt is up; the shell's own paste mode was switched off to run the command).
 */
function claudeReady(rt: Runtime, now: number): boolean {
  if (rt.startupSentAt === undefined || rt.socket?.readyState !== WebSocket.OPEN) return false
  return now - Math.max(rt.startupSentAt, rt.lastOutputAt) >= CLAUDE_SETTLE_MS && rt.term.modes.bracketedPasteMode
}

const claude: AgentProvider = {
  id: 'claude',
  label: 'Claude',
  glyph: '✦',
  buttonClass: 'wt-btn-claude',
  command: 'claude',
  startup: 'claude',
  presets: ['claude', 'claude --resume', 'claude --continue'],
  matchStartup: CLAUDE_COMMAND,
  matchCommand: /^\s*(?:\S*[\\/])?claude(?:\.(?:exe|cmd|ps1))?(?=\s|$)/i,
  title: /^Claude Code$/i,
  launch: claudeLaunch,
  ready: claudeReady,
}

// ── Antigravity CLI ──

/** `agy` as the first word of a command. */
const AGY_COMMAND = /^(\s*)agy(?=\s|$)/
/** A flag that already chooses a conversation. */
const AGY_HAS_CONVERSATION = /(?:^|\s)(?:--conversation|--continue|-c)(?:\s|=|$)/

/**
 * Reopen where agy left off: a known conversation id becomes `--conversation <id>`; with none but a
 * terminal that has had a turn (the app closed while agy ran, so no id was printed), `-c` continues the
 * latest conversation in the folder; otherwise plain `agy`. A command that already chooses one is left alone.
 */
function agyLaunch(startup: string, _launch: LaunchHint, session?: string | null, turned?: boolean): string {
  if (!AGY_COMMAND.test(startup) || AGY_HAS_CONVERSATION.test(startup)) return startup
  const flag = isSessionId(session) ? `--conversation ${session}` : turned === true ? '-c' : undefined
  return flag === undefined ? startup : startup.replace(AGY_COMMAND, (_all, lead: string) => `${lead}agy ${flag}`)
}

/** Ready once agy has reported `idle` (its prompt is up) after the startup command was typed. */
function agyReady(rt: Runtime, _now: number): boolean {
  return rt.startupSentAt !== undefined && rt.socket?.readyState === WebSocket.OPEN && rt.agent?.provider === 'antigravity' && rt.agent.state === 'idle'
}

const antigravity: AgentProvider = {
  id: 'antigravity',
  label: 'Antigravity',
  glyph: '◈',
  buttonClass: 'wt-btn-agy',
  command: 'agy',
  startup: 'agy',
  presets: ['agy', 'agy -c'],
  matchStartup: AGY_COMMAND,
  matchCommand: /^\s*(?:\S*[\\/])?agy(?:\.(?:exe|cmd|ps1))?(?=\s|$)/i,
  // PowerShell and conhost title the window with the program's path.
  title: /^(?:.*[\\/])?agy(?:\.exe)?$/i,
  launch: agyLaunch,
  ready: agyReady,
  sessionOnEnd: true,
}

// ── the registry ──

/** Every provider the UI offers, in button order. */
export const providers: readonly AgentProvider[] = [claude, antigravity]

/** The provider with this id, or undefined (an id from a newer or older version, or none). */
export function providerById(id: string | undefined): AgentProvider | undefined {
  return id === undefined ? undefined : providers.find((p) => p.id === id)
}

/** The provider a startup command starts, or undefined for a plain shell command. */
export function providerForCommand(startup: string | undefined): AgentProvider | undefined {
  return startup === undefined ? undefined : providers.find((p) => p.matchStartup.test(startup))
}

/** The provider a window runs: the one saved with it, else the one its startup command starts. */
export function providerOfWin(win: Pick<WinState, 'provider' | 'startup'>): AgentProvider | undefined {
  return providerById(win.provider) ?? providerForCommand(win.startup)
}

/** The provider whose program set this terminal title, or undefined. */
export function providerForTitle(title: string): AgentProvider | undefined {
  return providers.find((p) => p.title.test(title))
}

/** Whether any provider runs this command line, as typed in a shell. */
export function isAgentCommand(command: string): boolean {
  return providers.some((p) => p.matchCommand.test(command))
}
