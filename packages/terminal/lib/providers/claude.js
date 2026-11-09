// dsh-web-terminal — the Claude Code provider (host half).
//
// Claude Code reports through hooks listed in a `--settings` file the host writes at start;
// the client adds that file to the `claude` command line (the `launch` hint below). Besides
// agent state it feeds three Claude-only streams: the files it changed, the status line's
// usage numbers, and its sub-agents. Those arrive on their own `/signal/<route>` URLs.
//
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EDIT_MATCHER } from '../edits.js'
import { TOKEN_ENV, TOKEN_HEADER, clean } from '../agent-signals.js'
import { userStatusLine } from '../statusline.js'
import { createClaudeUsage } from './claude-usage.js'

/** Absolute path of the status-line wrapper Claude runs. */
const STATUSLINE_SCRIPT = fileURLToPath(new URL('../statusline.js', import.meta.url))
const HOOK_POST_SCRIPT = fileURLToPath(new URL('../hook-post.js', import.meta.url))
/** Refresh interval (s) for the wrapper when the user's own status line sets none. */
const DEFAULT_REFRESH_S = 10

/** `Bash: npm test` style summary of a tool call awaiting permission. */
function describeTool(body) {
  const tool = typeof body.tool_name === 'string' ? body.tool_name : 'a tool'
  const input = body.tool_input !== null && typeof body.tool_input === 'object' ? body.tool_input : {}
  const target = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern
  return typeof target === 'string' && target.length > 0 ? `${tool}: ${clean(target)}` : tool
}

/** Notification types that mean the agent is blocked on the user. */
const NEEDS_YOU_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])
/** Notification types that mean the turn is over and the agent is waiting for the next prompt. */
const FINISHED_NOTIFICATIONS = new Set(['idle_prompt', 'agent_completed'])

/**
 * Claude Code hook payload -> signal, or undefined for events that say nothing about state.
 * @param body - the JSON a Claude Code hook delivers (`hook_event_name` selects the event).
 */
export function claudeAdapter(body) {
  switch (body.hook_event_name) {
    case 'SessionStart':
      return { state: 'idle', detail: '' }
    case 'UserPromptSubmit':
    // The user answered a permission prompt and the tool ran, or the turn moved on: working again.
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      return { state: 'working', detail: '' }
    case 'PermissionRequest':
      return { state: 'needs-you', detail: `Permission: ${describeTool(body)}` }
    case 'Notification': {
      const type = body.notification_type
      if (NEEDS_YOU_NOTIFICATIONS.has(type)) return { state: 'needs-you', detail: clean(body.message) }
      if (FINISHED_NOTIFICATIONS.has(type)) return { state: 'finished', detail: '' }
      return undefined
    }
    case 'Stop':
      return { state: 'finished', detail: '' }
    case 'StopFailure':
      return { state: 'failed', detail: clean(`${body.error_type ?? 'error'}${body.error_message ? `: ${body.error_message}` : ''}`) }
    case 'SessionEnd':
      return { state: 'ended', detail: '' }
    default:
      return undefined
  }
}

/** Claude Code hook events the plugin subscribes to (the ones `claudeAdapter` understands). */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
]

/** Hook events about sub-agents: the host tracks them separately, they carry no agent state. */
export const CLAUDE_SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop']

/**
 * The `--settings` file that makes Claude Code report to this plugin.
 *
 * HTTP hooks (not shell commands) so nothing depends on the user's shell or quoting. The
 * URL is fixed text (hooks cannot interpolate it), so the file is written for one host
 * process and its port. The secret is not in the file: the hook header interpolates it
 * from the terminal's environment, which only that terminal's processes can see.
 * @param url - full URL of this host's Claude signal endpoint.
 * SessionStart is the exception: Claude Code only runs `command` hooks for it (an HTTP hook is
 * silently ignored), so it runs `hook-post.js`, which forwards the payload. Without `hookScript`
 * (no `node`) it is left out.
 * @param options.hookScript - absolute path of lib/hook-post.js, for the SessionStart command hook.
 * @param options.editUrl - the "files the agent changed" endpoint: adds a second PostToolUse group, matched to the editing tools (Edit|Write|MultiEdit|NotebookEdit), that posts there. It is not an agent-state signal.
 * @param options.subagentLine - {script, url}: install the sub-agent status-line wrapper (`script` = lib/statusline.js, `url` = the sub-agents endpoint).
 * @param options.statusLine - {script, url, refreshInterval}: also install the status-line wrapper
 *   (`script` = absolute path of lib/statusline.js, `url` = the usage endpoint). Omitted when
 *   `node` cannot be found, so the user's own status line keeps working untouched.
 */
export function buildClaudeSettings(url, { statusLine, hookScript, subagentLine, editUrl } = {}) {
  const hook = {
    type: 'http',
    url,
    timeout: 5,
    headers: { [TOKEN_HEADER]: `$${TOKEN_ENV}` },
    allowedEnvVars: [TOKEN_ENV],
  }
  const hooks = {}
  for (const event of [...CLAUDE_HOOK_EVENTS, ...CLAUDE_SUBAGENT_EVENTS]) {
    if (event !== 'SessionStart') hooks[event] = [{ hooks: [hook] }]
    else if (hookScript !== undefined) hooks[event] = [{ hooks: [{ type: 'command', command: `node "${hookScript.replaceAll('\\', '/')}" ${url}`, timeout: 5 }] }]
  }
  // Files the agent changed: a second PostToolUse group (the first, unmatched one drives agent state).
  if (editUrl !== undefined) hooks.PostToolUse = [...hooks.PostToolUse, { matcher: EDIT_MATCHER, hooks: [{ ...hook, url: editUrl }] }]
  const settings = { hooks }
  if (statusLine !== undefined) {
    // `statusLine` replaces the user's own; the wrapper runs theirs and relays its output.
    // The refresh interval is theirs too, so a time-based status line keeps ticking.
    settings.statusLine = {
      type: 'command',
      command: `node "${statusLine.script.replaceAll('\\', '/')}" ${statusLine.url}`,
      refreshInterval: statusLine.refreshInterval,
    }
  }
  if (subagentLine !== undefined) {
    // Prints nothing unless the user has their own sub-agent status line, so Claude's rows stay as they are.
    settings.subagentStatusLine = { type: 'command', command: `node "${subagentLine.script.replaceAll('\\', '/')}" --subagents ${subagentLine.url}` }
  }
  return settings
}

/** Settings files of host processes that no longer exist are litter. */
const STALE_SETTINGS = /^claude-settings-(\d+)\.json$/

/**
 * Write this host's `--settings` file. Called once, when the signal server is listening.
 * @param env - what the host knows at that point: see `Provider.prepare` in providers/index.js.
 */
function prepare({ dir, pid, base, nodePath, pidAlive }) {
  // The wrapper runs under `node`; without it on PATH keep the user's own status line.
  const statusLineReason = nodePath === undefined ? 'node not on PATH' : null
  try {
    mkdirSync(dir, { recursive: true })
    for (const name of readdirSync(dir)) {
      const stale = STALE_SETTINGS.exec(name)
      if (stale !== null && Number(stale[1]) !== pid && !pidAlive(Number(stale[1]))) rmSync(join(dir, name), { force: true })
    }
    const file = join(dir, `claude-settings-${pid}.json`)
    const statusLine =
      nodePath === undefined
        ? undefined
        : { script: STATUSLINE_SCRIPT, url: `${base}/usage`, refreshInterval: userStatusLine()?.refreshInterval ?? DEFAULT_REFRESH_S }
    // SessionStart only runs command hooks, and the sub-agent status line is a command too: both need node.
    const hookScript = nodePath === undefined ? undefined : HOOK_POST_SCRIPT
    const subagentLine = nodePath === undefined ? undefined : { script: STATUSLINE_SCRIPT, url: `${base}/subagents` }
    writeFileSync(file, `${JSON.stringify(buildClaudeSettings(`${base}/claude`, { statusLine, hookScript, subagentLine, editUrl: `${base}/claude-edit` }), null, 2)}\n`)
    return { launch: { settingsPath: file }, statusLineReason, dispose: () => rmSync(file, { force: true }) }
  } catch {
    return { launch: null, statusLineReason: 'settings file could not be written' }
  }
}

/**
 * Sub-agent hooks and the end of the Claude session, before the event is read as an agent state.
 * @returns true when the event was a sub-agent one (no agent state to derive).
 */
function trackSubagents({ session, body }, host) {
  switch (body?.hook_event_name) {
    case 'SubagentStart':
      if (session.subagents.start(body)) host.notifySubagents(session)
      return true
    case 'SubagentStop':
      if (session.subagents.stop(body)) host.notifySubagents(session)
      return true
    case 'SessionEnd':
      if (session.subagents.endAll()) host.notifySubagents(session)
      return false
    default:
      return false
  }
}

/** @type {import('./index.js').Provider} */
export const claude = {
  id: 'claude',
  label: 'Claude Code',
  commands: ['claude'],
  adapter: claudeAdapter,
  prepare,
  intercept: trackSubagents,
  usage: () => createClaudeUsage(),
  routes: {
    // A file the agent changed: not an agent state.
    'claude-edit': ({ session, body }, host) => {
      if (session.edits.ingest(body)) host.notifyEdits(session)
    },
    // The status line's payload: limits and cost, not an agent state.
    usage: ({ id, body }, host) => host.ingestUsage('claude', id, body),
    // The sub-agent status line's payload: the live task list.
    subagents: ({ session, body }, host) => {
      if (session.subagents.ingestTasks(body)) host.notifySubagents(session)
    },
  },
}
