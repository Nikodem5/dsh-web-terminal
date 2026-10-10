// dsh-web-terminal — agent signals (host half).
//
// An agent signal is a provider-neutral statement about one terminal's agent:
//
//   { provider, state, detail }
//
// where `state` is one of AGENT_STATES. It is the only trusted source of an agent's
// state; nothing is inferred from terminal output. A provider adapter turns the
// provider's own event payload into a signal. Claude Code is the first adapter; a
// future provider adds one function to ADAPTERS and, if it can call an HTTP endpoint,
// nothing else.
//
import { EDIT_MATCHER } from './edits.js'

// Pure functions only: no I/O, so the mapping is unit-tested without a host.

/**
 * What an agent is doing, from the user's point of view.
 *  - idle:      session is open and waiting for a first prompt
 *  - working:   a turn is in progress
 *  - needs-you: blocked on the user (permission, question)
 *  - finished:  the turn ended; waiting for the next prompt
 *  - failed:    the turn ended with an error
 *  - ended:     the agent program exited
 */
export const AGENT_STATES = ['idle', 'working', 'needs-you', 'finished', 'failed', 'ended']

/** Longest detail text carried to the browser (it is shown in a tooltip and a notification). */
const DETAIL_MAX = 160

/**
 * What a conversation id may look like. Claude's are UUIDs. The id is later typed into a
 * shell (`claude --resume <id>`), so anything outside this shape is dropped, never quoted.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

/** The conversation id a payload carries, if it is a safe one. */
function sessionOf(body) {
  const raw = body.session ?? body.session_id
  return typeof raw === 'string' && SESSION_ID.test(raw) ? raw : undefined
}

/** Collapse whitespace and cap length so a signal never carries a transcript. */
function clean(text) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat
}

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

/** Provider id -> adapter. The provider is chosen by the URL path the hook posts to. */
export const ADAPTERS = {
  claude: claudeAdapter,
}

/**
 * Turn a request body into a signal.
 *
 * A body that already carries a valid `state` is a provider-neutral signal (how a future
 * provider, or a hand-rolled script, reports without an adapter); otherwise the
 * provider's adapter interprets it.
 * @param provider - provider id from the request path.
 * @param body - parsed JSON body.
 * @returns the signal (with the conversation id when the payload had a safe one), or undefined when the event carries no state.
 */
export function normalizeSignal(provider, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const session = sessionOf(body)
  const withSession = (signal) => (session === undefined ? signal : { ...signal, session })
  if (typeof body.state === 'string' && AGENT_STATES.includes(body.state)) {
    return withSession({ provider, state: body.state, detail: clean(body.detail) })
  }
  const adapter = ADAPTERS[provider]
  if (adapter === undefined) return undefined
  const signal = adapter(body)
  return signal === undefined ? undefined : withSession({ provider, ...signal })
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

/** Name of the env var that carries a terminal's secret into its shell. */
export const TOKEN_ENV = 'DSH_WT_TOKEN'
/** Header the hook sends the secret in. */
export const TOKEN_HEADER = 'x-dsh-wt-token'

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
