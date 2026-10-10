// dsh-web-terminal — files one terminal's Claude session changed (host half).
//
// A Claude `PostToolUse` hook (matcher: the editing tools) reports each successful edit. This
// module validates the payload and keeps, per terminal, the most recent changed files. It says
// nothing about the agent's state: it is a separate endpoint from the state hooks.
//
// Pure state, no I/O and no timers: the host passes the clock in.

import { posix, win32 } from 'node:path'

/** Tools whose PostToolUse carries a file the agent changed. */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** Hook matcher for the editing tools. */
export const EDIT_MATCHER = EDIT_TOOLS.join('|')
/** Most files kept per terminal; the oldest is dropped first. */
export const MAX_EDITS = 500
/** Longest path accepted. */
export const PATH_MAX = 1024

const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/

/** Absolute path in either flavour, normalised; undefined for anything else. */
function absolute(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PATH_MAX || raw.includes('\0')) return undefined
  if (WIN_ABS.test(raw)) return win32.normalize(raw)
  if (raw.startsWith('/')) return posix.normalize(raw)
  return undefined
}

/**
 * The file a PostToolUse payload says was changed, as an absolute normalised path.
 * A relative path is resolved against the payload's `cwd` when that is absolute.
 * @returns `{ path, tool }`, or undefined when the event is not a valid edit.
 */
export function parseEdit(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  if (body.hook_event_name !== undefined && body.hook_event_name !== 'PostToolUse') return undefined
  const tool = body.tool_name
  if (typeof tool !== 'string' || !EDIT_TOOLS.includes(tool)) return undefined
  const input = body.tool_input
  if (input === null || typeof input !== 'object') return undefined
  const raw = tool === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : input.file_path
  let path = absolute(raw)
  if (path === undefined && typeof raw === 'string' && raw.length > 0 && raw.length <= PATH_MAX && !raw.includes('\0')) {
    const cwd = absolute(body.cwd)
    if (cwd !== undefined) {
      const joined = WIN_ABS.test(cwd) ? win32.resolve(cwd, raw) : posix.resolve(cwd, raw)
      path = joined.length <= PATH_MAX ? joined : undefined
    }
  }
  return path === undefined ? undefined : { path, tool }
}

/**
 * @param options.now - clock (ms), injectable for tests.
 * @param options.max - cap on files kept.
 */
export function createEdits({ now = Date.now, max = MAX_EDITS } = {}) {
  /** @type {Map<string, {at: number, tool: string}>} oldest first */
  const files = new Map()
  return {
    /** Record a PostToolUse payload. @returns true when it was a valid edit (the list changed). */
    ingest(body) {
      const edit = parseEdit(body)
      if (edit === undefined) return false
      files.delete(edit.path)
      files.set(edit.path, { at: now(), tool: edit.tool })
      while (files.size > max) files.delete(files.keys().next().value)
      return true
    },
    /** The full list, oldest first. */
    list() {
      return [...files].map(([path, v]) => ({ path, at: v.at, tool: v.tool }))
    },
    clear() {
      files.clear()
    },
  }
}
