// dsh-web-terminal — all-time token totals (host half).
//
// Claude Code keeps a lifetime aggregate in ~/.claude/stats-cache.json, but only up to
// `lastComputedDate`. This adds what the session transcripts (~/.claude/projects/**/*.jsonl,
// sub-agent transcripts included) hold from after that date, so the total is current.
//
// Day boundary: LOCAL time. stats-cache dates are the user's calendar days, so the delta
// starts at the local midnight that ends `lastComputedDate`. (Checked against the user's
// files: days without activity near midnight agree under both readings, so the data could
// not prove it; local is how Claude Code buckets its daily activity.)
//
// Incremental: files are read from a per-file byte offset so a rescan only reads appended
// bytes, and scans yield between files and chunks so a big tree never freezes the host.

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHUNK = 1024 * 1024
const FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation']
const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const sumOf = (parts) => parts.input + parts.output + parts.cacheRead + parts.cacheCreation

/** Default Claude config dir (honours CLAUDE_CONFIG_DIR). */
export function claudeDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Milliseconds at the end of local day `YYYY-MM-DD` (= start of the next), or undefined if malformed. */
export function endOfLocalDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date))
  return m === null ? undefined : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime()
}

/** Sum a stats-cache `modelUsage` object. */
function baseOf(cache) {
  const base = empty()
  const models = cache?.modelUsage
  if (models === null || typeof models !== 'object') return base
  for (const usage of Object.values(models)) {
    base.input += count(usage?.inputTokens)
    base.output += count(usage?.outputTokens)
    base.cacheRead += count(usage?.cacheReadInputTokens)
    base.cacheCreation += count(usage?.cacheCreationInputTokens)
  }
  return base
}

/** Files stat-ed at once (one by one, a big tree is thousands of sequential round trips). */
const STAT_BATCH = 32
/** A folder changed this recently may still gain entries within the same timestamp tick: list it again. */
const FRESH_MS = 2000

/** `fn` over `items`, STAT_BATCH at a time, results in order. */
async function inBatches(items, fn) {
  const results = []
  for (let i = 0; i < items.length; i += STAT_BATCH) results.push(...(await Promise.all(items.slice(i, i + STAT_BATCH).map(fn))))
  return results
}

/**
 * Recursively list `.jsonl` files with size and mtime. Unreadable folders are skipped.
 * A folder's own mtime changes when files or folders are added or removed, so its listing is kept in `tree`
 * and read again only then; the files are still stat-ed every time, as appending to one does not touch the folder.
 */
async function listTranscripts(dir, tree, clock) {
  let dirMtime
  try {
    dirMtime = (await stat(dir)).mtimeMs
  } catch {
    tree.delete(dir)
    return []
  }
  let node = tree.get(dir)
  if (node === undefined || node.mtimeMs !== dirMtime || clock() - dirMtime < FRESH_MS) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      tree.delete(dir)
      return []
    }
    node = {
      mtimeMs: dirMtime,
      dirs: entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name)),
      files: entries.filter((e) => !e.isDirectory() && e.name.endsWith('.jsonl')).map((e) => join(dir, e.name)),
    }
    tree.set(dir, node)
  }
  const found = await inBatches(node.files, async (path) => {
    try {
      const info = await stat(path)
      return { path, size: info.size, mtimeMs: info.mtimeMs }
    } catch {
      return null
    }
  })
  const out = found.filter((f) => f !== null)
  for (const sub of node.dirs) out.push(...(await listTranscripts(sub, tree, clock)))
  return out
}

/**
 * @param options.dir - the Claude config dir.
 * @param options.intervalMs - minimum time between scan starts.
 * @param options.now - clock (ms).
 */
export function createTokenTotals({ dir = claudeDir(), intervalMs = 60_000, now = Date.now } = {}) {
  let latest = null
  let running = null
  let lastStart = -Infinity
  let onChange = () => {}
  /** State of the delta over the cache; thrown away when the cache's date moves. */
  let marker // lastComputedDate the delta was built for
  const offsets = new Map() // path -> bytes consumed (whole lines only)
  const tree = new Map() // folder -> {mtimeMs, dirs, files}: its last listing
  const seen = new Map() // message.id + requestId -> usage parts (max over streamed repeats)
  let delta = empty()

  /** Fold one usage into the delta; a repeated message keeps its largest figures. */
  const add = (key, usage) => {
    const prev = seen.get(key)
    if (prev === undefined) {
      seen.set(key, usage)
      for (const f of FIELDS) delta[f] += usage[f]
      return
    }
    for (const f of FIELDS) {
      if (usage[f] > prev[f]) {
        delta[f] += usage[f] - prev[f]
        prev[f] = usage[f]
      }
    }
  }

  const readLine = (line, cutoff) => {
    if (!line.includes('"usage"')) return
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const message = entry?.message
    const usage = message?.usage
    if (entry?.type !== 'assistant' || usage === null || typeof usage !== 'object') return
    const at = Date.parse(entry.timestamp)
    if (!(at > cutoff) || typeof message.id !== 'string') return
    add(`${message.id}|${entry.requestId ?? ''}`, {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheCreation: count(usage.cache_creation_input_tokens),
    })
  }

  /** Read the bytes appended to one file since its offset. */
  const readFrom = async (file, cutoff) => {
    let start = offsets.get(file.path) ?? 0
    if (file.size < start) start = 0 // truncated or replaced: reread (dedupe makes that safe)
    if (file.size === start) return
    const handle = await open(file.path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(CHUNK)
      let carry = Buffer.alloc(0)
      let position = start
      while (position < file.size) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, position)
        if (bytesRead === 0) break
        position += bytesRead
        const data = Buffer.concat([carry, buffer.subarray(0, bytesRead)])
        const cut = data.lastIndexOf(0x0a)
        if (cut < 0) {
          carry = data
          continue
        }
        for (const line of data.subarray(0, cut).toString('utf8').split('\n')) readLine(line, cutoff)
        carry = data.subarray(cut + 1)
        await new Promise((resolve) => setImmediate(resolve))
      }
      // A final line without newline may still be growing: leave it for the next scan.
      offsets.set(file.path, position - carry.length)
    } finally {
      await handle.close()
    }
  }

  const scanOnce = async () => {
    let cache
    try {
      cache = JSON.parse(await readFile(join(dir, 'stats-cache.json'), 'utf8'))
    } catch {
      cache = null
    }
    // Cache unreadable (config dir gone, file mid-rewrite): keep what we last knew rather than drop to zero.
    if (cache === null && latest !== null) return
    const date = typeof cache?.lastComputedDate === 'string' ? cache.lastComputedDate : ''
    if (date !== marker) {
      marker = date
      offsets.clear()
      seen.clear()
      delta = empty()
    }
    const cutoff = endOfLocalDay(date) ?? 0
    const files = await listTranscripts(join(dir, 'projects'), tree, now)
    for (const file of files) {
      if (file.mtimeMs < cutoff) continue
      try {
        await readFrom(file, cutoff)
      } catch {}
      await new Promise((resolve) => setImmediate(resolve))
    }
    const base = baseOf(cache)
    const parts = empty()
    for (const f of FIELDS) parts[f] = base[f] + delta[f]
    latest = { total: sumOf(parts), ...parts, asOf: now() }
    onChange()
  }

  return {
    /** The last finished total (null before the first scan); starts a scan when one is due. Never waits. */
    get() {
      if (running === null && now() - lastStart >= intervalMs) {
        lastStart = now()
        running = scanOnce().catch(() => {}).finally(() => { running = null })
      }
      return latest
    },
    /** Run one scan now and wait for it (tests; `get()` is the production path). */
    async scan() {
      while (running !== null) await running
      lastStart = now()
      running = scanOnce().finally(() => { running = null })
      await running.catch(() => {})
    },
    /** Called after every finished scan (the host uses it to schedule a save). */
    onScanned(fn) {
      onChange = fn
    },
    /** The last total, for persistence. */
    serialize() {
      return latest
    },
    /** Show a saved total until the first scan finishes. */
    restore(saved) {
      if (saved === null || typeof saved !== 'object') return
      const ok = ['total', 'input', 'output', 'cacheRead', 'cacheCreation', 'asOf'].every((k) => typeof saved[k] === 'number' && Number.isFinite(saved[k]))
      if (ok && latest === null) latest = { total: saved.total, input: saved.input, output: saved.output, cacheRead: saved.cacheRead, cacheCreation: saved.cacheCreation, asOf: saved.asOf }
    },
  }
}
