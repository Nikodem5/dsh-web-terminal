// dsh-web-terminal — pattern alerts, the pure half: what a pattern is, how one is validated at
// save time, and how terminal output is cut into completed, ANSI-free lines and matched.
//
// Nothing here touches the DOM or the store (state.ts imports this file to repair saved preferences),
// so the matching is tested without a browser. The stateful half is pattern-alerts.ts.

import type { AttentionLevel } from './types.ts'

/** A user-defined output trigger. Plain text unless `regex`. */
export interface PatternAlert {
  id: string
  /** Shown on the badge; empty = the pattern text. */
  name: string
  text: string
  regex: boolean
  caseSensitive: boolean
  /** `all`, or the id of the one terminal it applies to. */
  scope: string
  enabled: boolean
  level: AttentionLevel
  /** Seconds before the same pattern may alert again on the same terminal. */
  cooldownSec: number
}

/** Pattern text longer than this is refused (a long regex is rarely intended and is the usual way to build a slow one). */
export const TEXT_MAX = 200
export const NAME_MAX = 40
/** Patterns kept; every chunk of output is checked against the enabled ones. */
export const PATTERNS_MAX = 20
/** Matching looks at the first this-many characters of a line (after escapes are stripped). */
export const LINE_MAX = 2000
/** A regular expression looks at only the first this-many of those: a repeat that is merely polynomial stays cheap. */
export const REGEX_LINE_MAX = 500
/** One regular expression test that takes longer than this (ms) switches its pattern off (a page that never freezes is worth a missed alert). */
export const SLOW_MS = 25
/** Raw characters of an unfinished line kept between chunks: a line with no break never grows memory past this. */
export const RAW_MAX = 8192
export const COOLDOWN_DEFAULT = 30
export const COOLDOWN_MAX = 3600

export const SCOPE_ALL = 'all'

/** Examples shipped switched off: a permission prompt and a test-failure line. */
export function defaultPatternAlerts(): PatternAlert[] {
  return [
    { id: 'example-proceed', name: 'Asks to proceed', text: 'Do you want to proceed?', regex: false, caseSensitive: false, scope: SCOPE_ALL, enabled: false, level: 'urgent', cooldownSec: COOLDOWN_DEFAULT },
    { id: 'example-test-failure', name: 'Test failure', text: '(^|\\s)FAIL(ED)?\\b|\\b[1-9]\\d* (tests? )?failed\\b|^not ok \\d+', regex: true, caseSensitive: true, scope: SCOPE_ALL, enabled: false, level: 'quiet', cooldownSec: COOLDOWN_DEFAULT },
  ]
}

// ── validation ─────────────────────────────────────────────────────────────

/**
 * Backtracking cannot be interrupted in JavaScript, so a user's regular expression must not be able to
 * need it: `regexProblem` refuses the shapes that explode when saved, and the matcher still bounds line
 * length and time (see REGEX_LINE_MAX and SLOW_MS).
 *
 * Exponential: a group that repeats (`+`, `*`, `{n,}`, `{n,m}`) and holds an alternative (`(a|aa)+$`,
 * `(a|a)*b`), a repeat or an optional part (`(a+)+`, `(a{1,9})+x`, `(a?){25}a{25}`). Polynomial: many
 * unbounded repeats in a row (`.*.*.*.*x`), so only a few are allowed in total.
 */
export const UNBOUNDED_MAX = 3

interface Quantifier {
  /** Characters it takes (a trailing `?`, "lazy", included). */
  len: number
  /** It can match more than once (`+`, `*`, `{2,}`, `{1,9}`). */
  repeats: boolean
  /** It has no upper limit. */
  unbounded: boolean
}

/** The quantifier starting at `at`, if any. */
function quantifierAt(source: string, at: number): Quantifier | undefined {
  const c = source[at]
  let q: Omit<Quantifier, 'len'> | undefined
  let len = 1
  if (c === '+' || c === '*') q = { repeats: true, unbounded: true }
  else if (c === '?') q = { repeats: false, unbounded: false }
  else if (c === '{') {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(at, at + 24))
    if (m === null) return undefined
    const unbounded = m[2] !== undefined && m[3] === ''
    const max = m[2] === undefined ? Number(m[1]) : unbounded ? Infinity : Number(m[3])
    q = { repeats: max > 1, unbounded }
    len = m[0].length
  }
  if (q === undefined) return undefined
  if (source[at + len] === '?') len++
  return { len, ...q }
}

/** What is wrong with the shape of a regex source (see UNBOUNDED_MAX), or undefined. */
function shapeProblem(source: string): string | undefined {
  interface Frame { alt: boolean; quantified: boolean }
  const stack: Frame[] = [{ alt: false, quantified: false }]
  let unbounded = 0
  let i = 0
  /** Skip the quantifier after an atom that ends at `end`; returns where scanning goes on. */
  const quantified = (end: number): number => {
    const q = quantifierAt(source, end)
    if (q === undefined) return end
    stack[stack.length - 1]!.quantified = true
    if (q.unbounded) unbounded++
    return end + q.len
  }
  while (i < source.length) {
    const c = source[i]!
    if (c === '\\') {
      i = quantified(i + 2)
    } else if (c === '[') {
      let j = i + 1
      if (source[j] === '^') j++
      if (source[j] === ']') j++
      while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1
      i = quantified(j + 1)
    } else if (c === '(') {
      stack.push({ alt: false, quantified: false })
      i += /^\(\?(?:<[=!]|[:=!]|<[^>]*>)/.exec(source.slice(i, i + 40))?.[0].length ?? 1
    } else if (c === ')') {
      const group = stack.length > 1 ? stack.pop()! : { alt: false, quantified: false }
      const q = quantifierAt(source, i + 1)
      if (q?.repeats === true && (group.alt || group.quantified)) return 'A repeated group that holds an alternative or another repeat (like (a+)+ or (a|aa)*) can freeze the page; simplify it'
      const parent = stack[stack.length - 1]!
      parent.alt ||= group.alt
      parent.quantified ||= group.quantified
      i = quantified(i + 1)
    } else if (c === '|') {
      stack[stack.length - 1]!.alt = true
      i++
    } else {
      i = quantified(i + 1)
    }
  }
  if (unbounded > UNBOUNDED_MAX) return `A regular expression can have at most ${UNBOUNDED_MAX} open-ended repeats (*, + or {n,}); more can freeze the page`
  return undefined
}

/** Why a regex source is not acceptable, or undefined. */
export function regexProblem(source: string, caseSensitive: boolean): string | undefined {
  if (source.length > TEXT_MAX) return `A regular expression can be at most ${TEXT_MAX} characters`
  const shape = shapeProblem(source)
  if (shape !== undefined) return shape
  let re: RegExp
  try {
    re = new RegExp(source, caseSensitive ? '' : 'i')
  } catch (error) {
    return `Not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`
  }
  if (re.test('')) return 'This expression matches an empty line, so it would match every line'
  return undefined
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type PatternCheck = { ok: true; value: PatternAlert } | { ok: false; error: string }

/**
 * Turn a form value or a stored record into a pattern, or say what is wrong with it.
 * Used both when the user saves and when preferences are read back, so a hand-edited or damaged
 * entry cannot reach the matcher.
 */
export function checkPatternAlert(raw: unknown, makeId: () => string = newId): PatternCheck {
  if (!isObj(raw)) return { ok: false, error: 'Not a pattern' }
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (text.trim().length === 0) return { ok: false, error: 'Enter the text to look for' }
  const regex = raw.regex === true
  const caseSensitive = raw.caseSensitive === true
  if (!regex && text.length > TEXT_MAX) return { ok: false, error: `The text can be at most ${TEXT_MAX} characters` }
  if (regex) {
    const problem = regexProblem(text, caseSensitive)
    if (problem !== undefined) return { ok: false, error: problem }
  }
  const cooldown = typeof raw.cooldownSec === 'number' && Number.isFinite(raw.cooldownSec) ? Math.round(raw.cooldownSec) : COOLDOWN_DEFAULT
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : ''
  const scope = typeof raw.scope === 'string' && raw.scope.length > 0 && raw.scope.length <= 200 ? raw.scope : SCOPE_ALL
  const id = typeof raw.id === 'string' && /^[\w.-]{1,64}$/.test(raw.id) ? raw.id : makeId()
  return {
    ok: true,
    value: {
      id,
      name,
      text,
      regex,
      caseSensitive,
      scope,
      enabled: raw.enabled !== false,
      level: raw.level === 'quiet' ? 'quiet' : 'urgent',
      cooldownSec: Math.min(COOLDOWN_MAX, Math.max(0, cooldown)),
    },
  }
}

let idCounter = 0
function newId(): string {
  return `p${Date.now().toString(36)}${(idCounter++).toString(36)}`
}

/** Stored patterns, repaired: invalid ones are dropped, ids made unique, the count capped. */
export function cleanPatternAlerts(raw: unknown): PatternAlert[] {
  if (!Array.isArray(raw)) return defaultPatternAlerts()
  const seen = new Set<string>()
  const out: PatternAlert[] = []
  for (const item of raw) {
    const checked = checkPatternAlert(item)
    if (!checked.ok || seen.has(checked.value.id)) continue
    seen.add(checked.value.id)
    out.push(checked.value)
    if (out.length >= PATTERNS_MAX) break
  }
  return out
}

// ── matching ───────────────────────────────────────────────────────────────

/** OSC strings (title, links, cwd...), CSI sequences, then any other two-character escape. */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC_OTHER = /\x1b[ -/]*[0-~]/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g
const HAS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/

/** Text as it reads on screen: escape sequences and control characters removed, tabs as spaces. */
export function stripAnsi(raw: string): string {
  if (!HAS_CONTROL.test(raw) && !raw.includes('\t')) return raw
  return raw.replace(OSC, '').replace(CSI, '').replace(ESC_OTHER, '').replace(/\t/g, ' ').replace(CONTROL, '')
}

/** One pattern ready to test lines against. */
export interface Matcher {
  pattern: PatternAlert
  test(line: string): boolean
  /** Set once a test went over SLOW_MS: it is not asked again. */
  slow?: boolean
}

const compiled = new Map<string, { key: string; matcher: Matcher | undefined }>()

/** The matcher for a pattern, built once and rebuilt when the pattern is edited. Undefined for one that no longer validates. */
export function matcherFor(pattern: PatternAlert): Matcher | undefined {
  const key = `${pattern.regex ? 'r' : 't'}${pattern.caseSensitive ? 'c' : 'i'}:${pattern.text}`
  const cached = compiled.get(pattern.id)
  if (cached !== undefined && cached.key === key) {
    if (cached.matcher !== undefined) cached.matcher.pattern = pattern // name, scope, level and cooldown can change without a rebuild
    return cached.matcher
  }
  let matcher: Matcher | undefined
  if (pattern.regex) {
    if (regexProblem(pattern.text, pattern.caseSensitive) === undefined) {
      const re = new RegExp(pattern.text, pattern.caseSensitive ? '' : 'i')
      matcher = { pattern, test: (line) => re.test(line.length > REGEX_LINE_MAX ? line.slice(0, REGEX_LINE_MAX) : line) }
    }
  } else {
    const exact = pattern.caseSensitive
    const needle = exact ? pattern.text : pattern.text.toLowerCase()
    matcher = { pattern, test: (line) => (exact ? line : line.toLowerCase()).includes(needle) }
  }
  compiled.set(pattern.id, { key, matcher })
  if (compiled.size > PATTERNS_MAX * 4) compiled.delete(compiled.keys().next().value as string)
  return matcher
}

/** Forget the compiled form of a pattern (it gets a fresh chance, e.g. when the user switches it back on). */
export function forgetMatcher(id: string): void {
  compiled.delete(id)
}

/** The enabled patterns that apply to one terminal. */
export function activeMatchers(patterns: readonly PatternAlert[], terminalId: string): Matcher[] {
  const out: Matcher[] = []
  for (const p of patterns) {
    if (!p.enabled || (p.scope !== SCOPE_ALL && p.scope !== terminalId)) continue
    const m = matcherFor(p)
    if (m !== undefined && m.slow !== true) out.push(m)
  }
  return out
}

/** What is remembered between chunks of one terminal's output. */
export interface ScanState {
  /** The unfinished last line (raw, at most RAW_MAX characters). */
  partial: string
  /** The unfinished line already hit RAW_MAX: the rest of it is skipped. */
  overflow: boolean
  /** Pattern id -> when it last alerted. */
  fired: Map<string, number>
}

export function newScanState(): ScanState {
  return { partial: '', overflow: false, fired: new Map() }
}

export interface AlertHit {
  pattern: PatternAlert
  line: string
}

const LINE_BREAK = /\r\n|\n|\r/

/**
 * Feed one chunk of output; returns the patterns that matched a completed line in it.
 * Work is proportional to the chunk: only the new text is split, and a pattern still cooling
 * down is skipped without being tested. Each pattern hits at most once per call.
 * A regular expression that takes longer than SLOW_MS on one line is switched off (`onSlow` is told).
 * @param matchers - the active patterns for this terminal (`activeMatchers`).
 * @param options.clock - milliseconds, monotonic (tests pass their own).
 */
export function scanChunk(
  state: ScanState,
  chunk: string,
  matchers: readonly Matcher[],
  now: number,
  options: { onSlow?: (pattern: PatternAlert, ms: number) => void; clock?: () => number } = {},
): AlertHit[] {
  const clock = options.clock ?? (() => performance.now())
  const hits: AlertHit[] = []
  // With nothing to look for there is nothing to keep either: no line is being assembled.
  if (matchers.length === 0) {
    state.partial = ''
    state.overflow = false
    return hits
  }
  const complete = (raw: string): void => {
    const line = stripAnsi(raw).slice(0, LINE_MAX).trim()
    if (line.length === 0) return
    for (const m of matchers) {
      const last = state.fired.get(m.pattern.id)
      if (m.slow === true) continue
      if (last !== undefined && now - last < m.pattern.cooldownSec * 1000) continue
      const began = m.pattern.regex ? clock() : 0
      const matched = m.test(line)
      if (m.pattern.regex) {
        const took = clock() - began
        if (took > SLOW_MS) {
          m.slow = true
          options.onSlow?.(m.pattern, took)
        }
      }
      if (!matched) continue
      state.fired.set(m.pattern.id, now)
      hits.push({ pattern: m.pattern, line })
    }
  }
  const parts = chunk.split(LINE_BREAK)
  if (!state.overflow) {
    state.partial += parts[0]!
    if (state.partial.length > RAW_MAX) {
      state.partial = state.partial.slice(0, RAW_MAX)
      state.overflow = true
    }
  }
  if (parts.length === 1) return hits
  complete(state.partial)
  for (let i = 1; i < parts.length - 1; i++) complete(parts[i]!.length > RAW_MAX ? parts[i]!.slice(0, RAW_MAX) : parts[i]!)
  const last = parts[parts.length - 1]!
  state.overflow = last.length > RAW_MAX
  state.partial = state.overflow ? last.slice(0, RAW_MAX) : last
  return hits
}

/** One-line label with a length cap. */
export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
