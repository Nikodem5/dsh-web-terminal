// dsh-web-terminal — Overseer: a Claude Code transcript (JSONL on disk) as a short account.
//
// Claude Code writes every conversation to `<config dir>/projects/<project>/<session>.jsonl`, and
// its hook payloads name that file (`transcript_path`). The Overseer reads it to say what an agent
// was asked, what it answered and what it did, without the bulk: user prompts, assistant text,
// one line per tool call, sub-agent hand-offs and their reports. Raw tool output is never included.
//
// Reading is asynchronous, tail-first and incremental: the first read takes only the last
// `TAIL_BYTES` of the file, later reads only what was appended, and parsing yields to the event
// loop between batches so a large transcript never stalls the host.

import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** The first read of a transcript takes at most this many bytes from its end. */
export const TAIL_BYTES = 2 * 1024 * 1024
/** A later read takes at most this many newly appended bytes (more than that: re-read the tail). */
const APPEND_BYTES = 4 * 1024 * 1024
/** Entries kept per transcript (oldest dropped first). */
const MAX_ENTRIES = 600
/** Lines parsed between yields to the event loop. */
const BATCH = 200
/** A single line longer than this is skipped unparsed (an API request blob, a huge pasted file). */
const MAX_LINE = 1024 * 1024

/** Longest text kept per entry kind (characters). */
const LIMITS = { user: 1200, assistant: 1500, tool: 200, subagent: 400, report: 600 }

/** Tool names that hand work to a sub-agent. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

/** Collapse whitespace and cap a string. */
function squash(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Drop the harness's own wrappers from a prompt (reminders, command echoes, hook context). */
function cleanPrompt(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<(?:local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>[\s\S]*?<\/(?:local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/g, ' [command output omitted] ')
    .replace(/<command-(?:name|message|args)>([\s\S]*?)<\/command-(?:name|message|args)>/g, ' $1 ')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/g, ' ')
}

/** The string fields of a tool input worth one line: the command, the path, the pattern... */
function toolTarget(input) {
  if (input === null || typeof input !== 'object') return ''
  for (const key of ['command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']) {
    if (typeof input[key] === 'string' && input[key].length > 0) return input[key]
  }
  return ''
}

/** Text of a tool_result's content (a string or text blocks). */
function resultText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ')
}

/**
 * A condenser for one transcript: feed it parsed JSONL records in order and read the entries.
 * Each entry is `{kind, text, at?, sidechain?}` with kind one of user, assistant, tool, subagent, report, title.
 * @returns {{push: (record: unknown) => void, entries: () => Array<object>, title: () => string|undefined}}
 */
export function createCondenser() {
  const entries = []
  /** Sub-agent tool calls by tool_use id, so their result can be reported as the sub-agent's answer. */
  const subagentCalls = new Map()
  let title
  const add = (entry) => {
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  }
  const push = (record) => {
    if (record === null || typeof record !== 'object') return
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
      title = squash(record.customTitle, 120)
      return
    }
    if (record.type === 'summary' && typeof record.summary === 'string') {
      title ??= squash(record.summary, 120)
      return
    }
    if (record.type !== 'user' && record.type !== 'assistant') return
    if (record.isMeta === true || record.isCompactSummary === true) return
    const content = record.message?.content
    const at = typeof record.timestamp === 'string' ? record.timestamp : undefined
    const sidechain = record.isSidechain === true ? true : undefined
    const base = (kind, text, max) => {
      const t = squash(text, max)
      if (t.length > 0) add({ kind, text: t, ...(at === undefined ? {} : { at }), ...(sidechain ? { sidechain } : {}) })
    }
    if (record.type === 'user') {
      if (typeof content === 'string') {
        base('user', cleanPrompt(content), LIMITS.user)
        return
      }
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') base('user', cleanPrompt(block.text), LIMITS.user)
        else if (block.type === 'tool_result' && subagentCalls.has(block.tool_use_id)) {
          // A sub-agent's final report is its turn, not raw tool output.
          const call = subagentCalls.get(block.tool_use_id)
          subagentCalls.delete(block.tool_use_id)
          base('report', `${call}: ${resultText(block.content)}`, LIMITS.report)
        }
        // Every other tool_result is raw tool output: never included.
      }
      return
    }
    if (!Array.isArray(content)) {
      if (typeof content === 'string') base('assistant', content, LIMITS.assistant)
      return
    }
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') base('assistant', block.text, LIMITS.assistant)
      else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input !== null && typeof block.input === 'object' ? block.input : {}
        if (SUBAGENT_TOOLS.has(block.name)) {
          const type = typeof input.subagent_type === 'string' && input.subagent_type.length > 0 ? input.subagent_type : 'sub-agent'
          const what = typeof input.description === 'string' ? input.description : ''
          const label = squash(`${type}${what ? ` "${what}"` : ''}`, 120)
          if (typeof block.id === 'string') subagentCalls.set(block.id, label)
          const prompt = typeof input.prompt === 'string' ? ` — ${input.prompt}` : ''
          base('subagent', `started ${label}${prompt}`, LIMITS.subagent)
        } else {
          const target = toolTarget(input)
          base('tool', `${block.name}${target ? `: ${target}` : ''}`, LIMITS.tool)
        }
      }
      // thinking / redacted_thinking blocks are left out.
    }
  }
  return { push, entries: () => entries, title: () => title }
}

/**
 * Condensed entries as text lines, newest last, within `maxChars` (oldest dropped first).
 * @returns {{text: string, truncated: boolean}}
 */
export function formatEntries(entries, maxChars) {
  const label = { user: 'USER', assistant: 'AGENT', tool: 'TOOL', subagent: 'SUBAGENT', report: 'SUBAGENT REPORT' }
  const lines = []
  let size = 0
  let truncated = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (label[e.kind] === undefined) continue
    const line = `${e.sidechain ? '(sub-agent) ' : ''}${label[e.kind]}: ${e.text}`
    if (size + line.length + 1 > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    size += line.length + 1
  }
  lines.reverse()
  return { text: lines.join('\n'), truncated }
}

/** Parse JSONL text into records, yielding to the event loop between batches. */
async function parseLines(text, onRecord) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 1 && line.length <= MAX_LINE) {
      try {
        onRecord(JSON.parse(line))
      } catch {}
    }
    if (i % BATCH === BATCH - 1) await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Read `length` bytes at `position` of an open file. */
async function readRange(handle, position, length) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
    if (bytesRead === 0) break
    done += bytesRead
  }
  return buffer.subarray(0, done)
}

/** The Claude config folders a transcript may live in: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDirs(env = process.env, home = homedir()) {
  const dirs = [join(home, '.claude')]
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.length > 0) dirs.unshift(env.CLAUDE_CONFIG_DIR)
  return dirs
}

/** Whether `child` is inside `parent` (both real paths). */
function inside(parent, child) {
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Resolve a transcript path for reading, or undefined when it may not be read: it must be an
 * absolute `.jsonl` path that, after following links, lies inside a Claude config folder.
 * @param path - the path a hook reported.
 * @param dirs - allowed config folders (default: `claudeConfigDirs()`).
 */
export async function allowedTranscript(path, dirs = claudeConfigDirs()) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || !isAbsolute(path) || !path.toLowerCase().endsWith('.jsonl')) return undefined
  let real
  try {
    real = await realpath(path)
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    try {
      if (inside(await realpath(dir), real)) return real
    } catch {}
  }
  return undefined
}

/**
 * A cache of condensed transcripts by path, read incrementally.
 * @param options.dirs - allowed config folders (tests point this at a temp folder).
 */
export function createTranscriptReader({ dirs } = {}) {
  /** path -> {size, condenser, partial} */
  const cache = new Map()

  /**
   * The condensed entries of one transcript, reading only what changed since the last call.
   * @returns {Promise<{entries: object[], title?: string, partial: boolean}|undefined>} undefined when it may not or cannot be read.
   */
  const read = async (path) => {
    const real = await allowedTranscript(path, dirs ?? claudeConfigDirs())
    if (real === undefined) return undefined
    let info
    try {
      info = await stat(real)
    } catch {
      return undefined
    }
    if (!info.isFile()) return undefined
    let entry = cache.get(real)
    const size = info.size
    let from
    if (entry !== undefined && size >= entry.size && size - entry.size <= APPEND_BYTES) {
      from = entry.size
    } else {
      // First read, a rewritten file or a huge append: start again from the tail.
      entry = { size: 0, condenser: createCondenser(), partial: false }
      from = Math.max(0, size - TAIL_BYTES)
      entry.partial = from > 0
    }
    if (size > from) {
      let handle
      try {
        handle = await open(real, 'r')
        const bytes = await readRange(handle, from, size - from)
        // An append may end mid-line (Claude is still writing it): only whole lines are taken, the rest is read next time.
        const end = bytes.lastIndexOf(0x0a) + 1
        // A tail read starts mid-line: skip to the first line boundary.
        const start = from > 0 && entry.size === 0 ? bytes.indexOf(0x0a) + 1 : 0
        if (end > start) await parseLines(bytes.subarray(start, end).toString('utf8'), entry.condenser.push)
        entry.size = from + end
      } catch {
        return undefined
      } finally {
        await handle?.close().catch(() => {})
      }
    }
    cache.set(real, entry)
    if (cache.size > 64) cache.delete(cache.keys().next().value)
    return { entries: entry.condenser.entries(), title: entry.condenser.title(), partial: entry.partial }
  }
  return { read, forget: (path) => cache.delete(path) }
}
