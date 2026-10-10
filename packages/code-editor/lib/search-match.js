// Search in files: the pure parts (query -> matcher, globs, previews, result caps). No fs, no processes, so they can
// run on the main thread, inside the search worker and in unit tests alike.
import { EditorError } from './errors.js'

export const MAX_QUERY_LEN = 1000
export const MAX_GLOB_LEN = 500
export const MAX_GLOBS = 20
export const MAX_MATCHES = 2000
export const MAX_FILES = 200
export const PREVIEW_LEN = 200
/** Lines longer than this are matched on their first LINE_SCAN characters only (bounds regex cost per line). */
export const LINE_SCAN = 10_000
const MAX_PER_LINE = 50

/** Escape a string for use inside a RegExp source. */
export const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch)

/**
 * Normalise and validate the query parameters. Throws EditorError 400 `bad-pattern` for an empty/oversized query or an
 * invalid regular expression (JavaScript syntax).
 */
export function normalizeParams({ q, regex = false, caseSensitive = false, word = false, include = '', exclude = '', max = MAX_MATCHES }) {
  if (typeof q !== 'string' || q === '') throw new EditorError(400, 'bad-request', 'q is required')
  if (q.length > MAX_QUERY_LEN) throw new EditorError(400, 'bad-request', `query is longer than ${MAX_QUERY_LEN} characters`)
  if (/[\u0000]/.test(q) || /[\r\n]/.test(q)) throw new EditorError(400, 'bad-request', 'query must be a single line')
  const params = {
    q,
    regex: regex === true,
    caseSensitive: caseSensitive === true,
    word: word === true,
    include: parseGlobs(include),
    exclude: parseGlobs(exclude),
    max: Math.min(MAX_MATCHES, Math.max(1, Number.isFinite(max) ? Math.floor(max) : MAX_MATCHES)),
  }
  buildMatcher(params) // throws bad-pattern
  return params
}

/** Split a comma separated glob list (commas inside braces stay), trimmed, validated. */
export function parseGlobs(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  if (text.length > MAX_GLOB_LEN) throw new EditorError(400, 'bad-request', 'include/exclude is too long')
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  const globs = []
  for (let g of out) {
    g = g.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '')
    if (g === '') continue
    if (/[\u0000-\u001f\u007f]/.test(g)) throw new EditorError(400, 'bad-request', 'glob contains control characters')
    if (g.split('/').includes('..')) throw new EditorError(400, 'bad-request', 'glob must not contain ..')
    globs.push(g)
  }
  if (globs.length > MAX_GLOBS) throw new EditorError(400, 'bad-request', `at most ${MAX_GLOBS} globs`)
  return globs
}

/** `a{b,c}d` -> [abd, acd]. One level of nesting is expanded recursively; an unbalanced brace stays literal. */
export function expandBraces(pattern, budget = { left: 64 }) {
  const open = pattern.indexOf('{')
  if (open < 0) return [pattern]
  let depth = 0
  let close = -1
  const commas = []
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        close = i
        break
      }
    } else if (ch === ',' && depth === 1) commas.push(i)
  }
  if (close < 0 || commas.length === 0) return [pattern]
  const head = pattern.slice(0, open)
  const tail = pattern.slice(close + 1)
  const parts = []
  let from = open + 1
  for (const c of [...commas, close]) {
    parts.push(pattern.slice(from, c))
    from = c + 1
  }
  const out = []
  for (const part of parts) {
    for (const rest of expandBraces(head + part + tail, budget)) {
      if (budget.left-- <= 0) return out
      out.push(rest)
    }
  }
  return out
}

/** The glob patterns (git `:(glob)` syntax) one user glob stands for: `*.ts` anywhere, `src` the folder anywhere. */
export function expandGlob(glob) {
  const out = []
  for (let g of expandBraces(glob)) {
    g = g.replace(/\/+$/, '')
    if (g === '') continue
    const anchored = g.startsWith('**/') || g.includes('/')
    const base = anchored ? g : `**/${g}`
    out.push(base, `${base}/**`)
  }
  return out
}

/** A glob (already expanded, git wildmatch flavour) as a RegExp over a forward-slash relative path. */
export function globToRegExp(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 2)
      if (end > 0) {
        let set = pattern.slice(i + 1, end)
        if (set.startsWith('!')) set = `^${set.slice(1)}`
        re += `[${set.replace(/\\/g, '\\\\')}]`
        i = end
      } else re += '\\['
    } else re += escapeRegExp(ch)
  }
  return new RegExp(`^${re}$`)
}

/** `(path) => boolean` for include/exclude lists (empty include = everything). */
export function pathFilter(include, exclude) {
  const compile = (globs) => globs.flatMap(expandGlob).map(globToRegExp)
  const inc = compile(include)
  const exc = compile(exclude)
  return (path) => (inc.length === 0 || inc.some((r) => r.test(path))) && !exc.some((r) => r.test(path))
}

/** git pathspec arguments for include/exclude (after `--`). */
export function gitPathspecs(include, exclude) {
  const inc = include.flatMap(expandGlob).map((g) => `:(glob)${g}`)
  const exc = exclude.flatMap(expandGlob).map((g) => `:(glob,exclude)${g}`)
  return [...(inc.length > 0 ? inc : ['.']), ...exc]
}

/**
 * Compile the query. `source` / `flags` are exposed so the git path can use the same semantics.
 * @returns `{ re }` a global RegExp; throws EditorError 400 `bad-pattern` for an invalid pattern.
 */
export function buildMatcher({ q, regex, caseSensitive, word }) {
  let source = regex ? q : escapeRegExp(q)
  if (word) {
    const first = regex ? 'a' : q[0]
    const last = regex ? 'a' : q[q.length - 1]
    const before = isWordChar(first) ? '(?<![\\p{L}\\p{N}_])' : ''
    const after = isWordChar(last) ? '(?![\\p{L}\\p{N}_])' : ''
    source = `${before}(?:${source})${after}`
  }
  try {
    return { re: new RegExp(source, `g${caseSensitive ? '' : 'i'}u`) }
  } catch (error) {
    try {
      // Patterns that are fine without the u flag (e.g. a lone `\-`) still work.
      return { re: new RegExp(source.replace(/\\p\{L\}\\p\{N\}_/g, 'A-Za-z0-9_'), `g${caseSensitive ? '' : 'i'}`) }
    } catch {
      throw new EditorError(400, 'bad-pattern', `Invalid regular expression: ${String(error?.message ?? error).replace(/^Invalid regular expression: /, '').slice(0, 200)}`)
    }
  }
}

/** All matches in one line: `[{ index, length }]` (UTF-16 offsets). Zero-length matches are skipped. */
export function findMatches(line, re) {
  const text = line.length > LINE_SCAN ? line.slice(0, LINE_SCAN) : line
  const out = []
  re.lastIndex = 0
  for (let m = re.exec(text); m !== null && out.length < MAX_PER_LINE; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push({ index: m.index, length: m[0].length })
  }
  return out
}

/** A one-line preview (~PREVIEW_LEN chars) around a match: `{ preview, at }` where `at` is the match offset in `preview`. */
export function makePreview(line, index, length) {
  const text = line.replace(/\r$/, '')
  const lead = text.length - text.trimStart().length
  let start = Math.min(lead, index)
  let end = text.length
  if (end - start > PREVIEW_LEN) {
    start = Math.max(start, index - 60)
    end = Math.min(text.length, Math.max(start + PREVIEW_LEN, index + length + 20))
    if (end - start > PREVIEW_LEN + length) end = start + PREVIEW_LEN + length
  }
  let preview = text.slice(start, end)
  let at = index - start
  if (start > Math.min(lead, index)) {
    preview = `…${preview}`
    at += 1
  }
  if (end < text.length) preview = `${preview.trimEnd()}…`
  return { preview, at: Math.max(0, at) }
}

/** The UTF-16 column (1-based) of a 1-based BYTE column in `text` (git reports bytes). */
export function byteColToCol(text, byteCol) {
  const bytes = Buffer.from(text, 'utf8')
  return bytes.subarray(0, Math.max(0, byteCol - 1)).toString('utf8').length + 1
}

/** Accumulates `{ path, matches }` groups under the file and match caps. */
export class Collector {
  constructor(maxMatches = MAX_MATCHES, maxFiles = MAX_FILES) {
    this.maxMatches = maxMatches
    this.maxFiles = maxFiles
    this.results = []
    this.byPath = new Map()
    this.matches = 0
    this.truncated = false
  }

  /** @returns false once a cap is hit (the caller stops searching). */
  add(path, match) {
    let group = this.byPath.get(path)
    if (group === undefined) {
      if (this.results.length >= this.maxFiles) {
        this.truncated = true
        return false
      }
      group = { path, matches: [] }
      this.byPath.set(path, group)
      this.results.push(group)
    }
    if (this.matches >= this.maxMatches) {
      this.truncated = true
      return false
    }
    group.matches.push(match)
    this.matches++
    if (this.matches >= this.maxMatches) {
      this.truncated = true
      return false
    }
    return true
  }

  get full() {
    return this.truncated
  }
}

/** Matches of one line as result entries. */
export function lineMatches(line, lineNo, re) {
  return findMatches(line, re).map(({ index, length }) => {
    const { preview, at } = makePreview(line, index, length)
    return { line: lineNo, col: index + 1, length, preview, at }
  })
}
