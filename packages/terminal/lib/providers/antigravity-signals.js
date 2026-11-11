// dsh-web-terminal — what the opt-in Antigravity integration reports, as neutral signals (host half).
//
// Two trusted channels, both posted with the terminal's secret (DSH_WT_TOKEN), so a program that only
// prints to the terminal cannot forge them:
//  - hooks (from the plugin the user installs, lib/agy-hook.mjs): `{ event, payload }` where payload is
//    what agy gives a hook on stdin (camelCase: conversationId, toolCall {name, args}, terminationReason...);
//  - the status line (launch-time `--settings`, lib/agy-statusline.mjs): agy's status-line JSON
//    (snake_case: conversation_id, agent_state, tool_confirmation_pending, quota, cost, context_window...).
// Formats checked against agy 1.5.3 (hooks: a live run; status line: the docs and a captured payload).
//
// Pure functions: no I/O.

import { SESSION_ID, clean } from '../agent-signals.js'

/**
 * agy's file-writing tools and the argument holding the path. `write_file`/`Path` is what agy 1.5.3 sent in
 * a live run; the others are the names its hook docs list (`TargetFile`).
 */
export const AGY_EDIT_TOOLS = {
  write_file: ['Path', 'TargetFile'],
  write_to_file: ['TargetFile', 'Path'],
  replace_file_content: ['TargetFile', 'Path'],
  multi_replace_file_content: ['TargetFile', 'Path'],
  edit_file: ['TargetFile', 'Path'],
}

/** The conversation id a payload names, when it is a safe one. */
export function agySessionOf(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const raw = payload.conversationId ?? payload.conversation_id ?? payload.session_id
  return typeof raw === 'string' && SESSION_ID.test(raw) ? raw : undefined
}

/**
 * The file a PostToolUse payload says was written, or undefined.
 * @returns {{path: string, tool: string} | undefined}
 */
export function agyEditOf(payload) {
  const call = payload?.toolCall
  if (call === null || typeof call !== 'object' || typeof call.name !== 'string') return undefined
  if (typeof payload.error === 'string' && payload.error.length > 0) return undefined
  const keys = AGY_EDIT_TOOLS[call.name]
  if (keys === undefined || call.args === null || typeof call.args !== 'object') return undefined
  for (const key of keys) {
    const path = call.args[key]
    if (typeof path === 'string' && path.length > 0) return { path, tool: call.name }
  }
  return undefined
}

/**
 * One hook post as a signal.
 * @param body - `{ event, payload }` from lib/agy-hook.mjs.
 * @returns `{ signal?, edit?, session? }` (signal: {state, detail}).
 */
export function agyHookSignal(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {}
  const payload = body.payload !== null && typeof body.payload === 'object' ? body.payload : {}
  const session = agySessionOf(payload)
  switch (body.event) {
    case 'SessionStart':
      return { session, signal: { state: 'idle', detail: '' } }
    case 'PreInvocation':
      return { session, signal: { state: 'working', detail: '' } }
    case 'PostToolUse':
      return { session, signal: { state: 'working', detail: '' }, edit: agyEditOf(payload) }
    case 'Stop': {
      const error = typeof payload.error === 'string' ? payload.error : ''
      const failed = error.length > 0 || String(payload.terminationReason ?? '').toLowerCase() === 'error'
      return { session, signal: failed ? { state: 'failed', detail: clean(error || 'error') } : { state: 'finished', detail: '' } }
    }
    default:
      return { session }
  }
}

/** Status-line `agent_state` values that mean a turn is in progress. */
const WORKING = new Set(['working', 'tool_use', 'reviewing'])

/**
 * A status-line payload as a signal, given the state the terminal already shows. The status line runs on
 * every state change, so this only answers when something changed.
 * @param payload - agy's status-line JSON.
 * @param current - the session's current agent state (`{state, kind?}`), or undefined.
 * @returns `{ signal?, session? }`.
 */
export function agyStatusSignal(payload, current) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const session = agySessionOf(payload)
  const state = payload.agent_state
  let signal
  if (payload.tool_confirmation_pending === true) signal = { state: 'needs-you', detail: 'Waiting for your approval' }
  else if (WORKING.has(state)) signal = { state: 'working', detail: '' }
  else if (state === 'authenticating') signal = { state: 'needs-you', detail: 'Sign-in', kind: 'auth' }
  else if (state === 'error') signal = { state: 'failed', detail: '' }
  else if (state === 'idle') {
    // Idle after a turn is a finished turn (the Stop hook says so too when the plugin is installed).
    if (current === undefined || current.state === 'ended') signal = { state: 'idle', detail: '' }
    else if (current.state === 'working' || current.state === 'needs-you') signal = { state: 'finished', detail: '' }
  }
  if (signal !== undefined && current !== undefined && current.state === signal.state && (current.kind ?? undefined) === signal.kind) signal = undefined
  return { session, signal }
}
