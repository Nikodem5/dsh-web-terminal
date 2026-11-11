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

/** A group that repeats and itself contains a repeat — `(a+)+`, `(.*)*`, `(\w+\s?)*` — is the classic catastrophic-backtracking shape. */
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,\d*\})/

/** Why a regex source is not acceptable, or undefined. */
export function regexProblem(source: string, caseSensitive: boolean): string | undefined {
  if (source.length > TEXT_MAX) return `A regular expression can be at most ${TEXT_MAX} characters`
  if (NESTED_REPEAT.test(source)) return 'A repeated group that itself repeats (like (a+)+) can freeze the page; simplify it'
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
      matcher = { pattern, test: (line) => re.test(line) }
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

/** The enabled patterns that apply to one terminal. */
export function activeMatchers(patterns: readonly PatternAlert[], terminalId: string): Matcher[] {
  const out: Matcher[] = []
  for (const p of patterns) {
    if (!p.enabled || (p.scope !== SCOPE_ALL && p.scope !== terminalId)) continue
    const m = matcherFor(p)
    if (m !== undefined) out.push(m)
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
 * @param matchers - the active patterns for this terminal (`activeMatchers`).
 */
export function scanChunk(state: ScanState, chunk: string, matchers: readonly Matcher[], now: number): AlertHit[] {
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
      if (last !== undefined && now - last < m.pattern.cooldownSec * 1000) continue
      if (!m.test(line)) continue
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
