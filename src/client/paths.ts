// dsh-web-terminal — finding file paths in terminal text (pure: no xterm, no DOM).
//
// The text is what xterm's buffer holds (no ANSI). Detection is generous about shape and strict about
// noise; the host then confirms which candidates exist, so a false guess costs one cached lookup and
// never shows as a link.

export interface PathMatch {
  /** Index of the first character and one past the last of the whole link (path plus position). */
  start: number
  end: number
  /** The path as written, without quotes, brackets or the position suffix. */
  path: string
  line?: number
  col?: number
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const WIN_ABS = /^[A-Za-z]:[\\/]/
const UNC = /^\\\\[^\\/\s]+[\\/][^\\/\s]+/
/** `name.ext`: the extension starts with a letter (so `1.2.3` is out) and is short. */
const BARE_FILE = /^[\w@+~-][\w@+.~-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/
/** Same, but a quoted name may hold spaces (`"my notes.txt"`). */
const BARE_FILE_SPACED = /^[\w@+~-][\w@+.~ -]*\.[A-Za-z][A-Za-z0-9]{0,9}$/
/** `.gitignore`, `.env`. */
const DOTFILE = /^\.[A-Za-z][\w.-]*$/
const OPENERS = '([{<"\'`'
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }
const TRAILING_PUNCT = /[.,;:!?'"`]/
/** `, line 12` / ` line 12, column 5` after a path (Python tracebacks and many CLIs). */
const LINE_WORDS = /^[,:]?\s+line\s+(\d+)(?:,?\s+col(?:umn)?\s+(\d+))?/i

/** Positive integer from digits, or undefined (also guards absurdly long numbers). */
function num(s: string | undefined): number | undefined {
  if (s === undefined || s.length > 7) return undefined
  const n = Number(s)
  return n > 0 ? n : undefined
}

/** True when `core` (no position suffix) is shaped like a path worth asking the host about. */
export function looksLikePath(core: string, quoted = false): boolean {
  if (core.length < 2 || core.length > 1024) return false
  if (URL_SCHEME.test(core) || /^(www\.|mailto:)/i.test(core)) return false
  if (WIN_ABS.test(core)) return core.length > 3
  if (UNC.test(core)) return true
  // Any other colon is a time (12:30), a key:value or a scheme.
  if (core.includes(':')) return false
  if (!/\p{L}/u.test(core)) return false // 3/4, 1/2/3
  if (core.startsWith('/')) return !core.startsWith('//')
  if (core === '~' || /^~[\\/]/.test(core)) return core.length > 2
  if (/[\\/]/.test(core)) return !core.startsWith('\\')
  return (quoted ? BARE_FILE_SPACED : BARE_FILE).test(core) || DOTFILE.test(core)
}

/**
 * Parse one token (or the inside of a quoted string) starting at `offset` in `text`.
 * @returns the match, or undefined when it is not a path.
 */
function parseToken(token: string, offset: number, text: string, quoted: boolean): PathMatch | undefined {
  let start = 0
  let end = token.length
  if (!quoted) {
    // Leading wrappers: `(`, `"`, and an option prefix like `--out=`.
    while (start < end && OPENERS.includes(token[start]!)) start++
    const eq = /^(?:-{1,2}[\w-]+|\w+)=/.exec(token.slice(start))
    if (eq !== null) start += eq[0].length
    // Trailing punctuation and closing brackets that have no opener inside the kept text.
    while (end > start) {
      const ch = token[end - 1]!
      const opener = CLOSERS[ch]
      if (TRAILING_PUNCT.test(ch) || (opener !== undefined && !token.slice(start, end - 1).includes(opener))) end--
      else break
    }
  }
  let body = token.slice(start, end)
  let line: number | undefined
  let col: number | undefined
  // Position suffixes: :12  :12:5  #L12  #L12-L20  (12)  (12,5).
  const m = /^(.+?)(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|\((\d+)(?:,\s*(\d+))?\))$/.exec(body)
  if (m !== null) {
    line = num(m[2] ?? m[4] ?? m[6])
    col = num(m[3] ?? m[5] ?? m[7])
    if (line === undefined) return undefined
    body = m[1]!
  }
  if (!looksLikePath(body, quoted)) return undefined
  let last = offset + end
  if (line === undefined) {
    const words = LINE_WORDS.exec(text.slice(quoted ? offset + token.length + 1 : last))
    if (words !== null) {
      line = num(words[1])
      col = num(words[2])
      last += (quoted ? 1 : 0) + words[0].length
    }
  }
  return { start: offset + start, end: last, path: body, line, col }
}

/**
 * Find the paths in one logical line.
 * Quoted strings with spaces are tried first (the only way to get spaces in a path), then every
 * whitespace-separated token.
 */
export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  const taken: Array<[number, number]> = []
  const overlaps = (a: number, b: number): boolean => taken.some(([s, e]) => a < e && b > s)

  // One character at a time after a failed pair, so an apostrophe cannot swallow a real opening quote.
  for (let i = 0; i < text.length; i++) {
    const q = text[i]!
    if (q !== '"' && q !== "'" && q !== '`') continue
    const close = text.indexOf(q, i + 1)
    if (close < 0) continue
    const inner = text.slice(i + 1, close)
    // No spaces inside: the token pass handles it. Padded with spaces: prose, not a path.
    if (inner.length < 2 || inner.length > 1024 || !/ /.test(inner) || /^\s|\s$|[\r\n\t]/.test(inner)) continue
    const match = parseToken(inner, i + 1, text, true)
    if (match === undefined) continue
    out.push(match)
    taken.push([i, Math.max(match.end, close + 1)])
    i = close
  }

  const token = /\S+/g
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    if (overlaps(m.index, m.index + m[0].length)) continue
    const match = parseToken(m[0], m.index, text, false)
    if (match !== undefined) out.push(match)
  }
  return out.sort((a, b) => a.start - b.start)
}
