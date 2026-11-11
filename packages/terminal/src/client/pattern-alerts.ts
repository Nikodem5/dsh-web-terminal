// dsh-web-terminal — pattern alerts, the stateful half: terminal output is checked against the user's
// patterns and a match raises the terminal's attention badge (the same one agents use).
//
// Output reaches a runtime whether or not its window is on screen (minimized, or the Terminals page
// not mounted), so the check runs on the incoming frame, not on what is rendered. Replays after a
// reattach are history and are never checked.

import { raiseAttention } from './attention.ts'
import type { Alert } from './attention.ts'
import { activeMatchers, checkPatternAlert, forgetMatcher, newScanState, PATTERNS_MAX, scanChunk, shorten } from './pattern-alerts-core.ts'
import type { PatternAlert, ScanState } from './pattern-alerts-core.ts'
import { showNotice } from './notices.ts'
import { emit, persistSoon, prefs } from './state.ts'
import type { Runtime } from './types.ts'

const states = new WeakMap<Runtime, ScanState>()

/** The alert one hit raises: the badge names the pattern, the tooltip the matching line. */
export function alertForHit(pattern: PatternAlert, line: string): Alert {
  const name = pattern.name.length > 0 ? pattern.name : pattern.text
  return { level: pattern.level, label: shorten(name, 24), reason: `Pattern “${shorten(name, 40)}” matched: ${shorten(line, 120)}` }
}

/** A regular expression that took too long on one line: switch it off for good (until the user switches it on) and say so. */
function switchOffSlow(pattern: PatternAlert, ms: number): void {
  const name = pattern.name.length > 0 ? pattern.name : pattern.text
  prefs.patternAlerts = prefs.patternAlerts.map((p) => (p.id === pattern.id ? { ...p, enabled: false } : p))
  emit()
  persistSoon()
  showNotice(`Pattern alert “${shorten(name, 30)}” was switched off: its regular expression took ${Math.round(ms)} ms on one line. Simplify it before switching it back on.`)
}

/** Check one live chunk of a terminal's output. Cheap when nothing applies: no pattern is enabled for this terminal. */
export function feedPatternAlerts(rt: Runtime, chunk: string, now = Date.now()): void {
  const patterns = prefs.patternAlerts
  let state = states.get(rt)
  if (state === undefined) {
    if (patterns.length === 0) return
    state = newScanState()
    states.set(rt, state)
  }
  const hits = scanChunk(state, chunk, activeMatchers(patterns, rt.id), now, { onSlow: switchOffSlow })
  for (const hit of hits) raiseAttention(rt, alertForHit(hit.pattern, hit.line))
}

/** The output was replaced (reattach, resync): a half line from before does not continue into what follows. */
export function resetPatternScan(rt: Runtime): void {
  const state = states.get(rt)
  if (state === undefined) return
  state.partial = ''
  state.overflow = false
}

// ── editing the list ───────────────────────────────────────────────────────

/**
 * Add a pattern, or replace the one with the same id.
 * @returns undefined when saved, else why it was refused (nothing changes).
 */
export function savePatternAlert(input: Partial<PatternAlert>): string | undefined {
  const checked = checkPatternAlert(input)
  if (!checked.ok) return checked.error
  const at = prefs.patternAlerts.findIndex((p) => p.id === checked.value.id)
  if (at < 0 && prefs.patternAlerts.length >= PATTERNS_MAX) return `At most ${PATTERNS_MAX} patterns`
  prefs.patternAlerts = at < 0 ? [...prefs.patternAlerts, checked.value] : prefs.patternAlerts.map((p, i) => (i === at ? checked.value : p))
  emit()
  persistSoon()
  return undefined
}

export function removePatternAlert(id: string): void {
  prefs.patternAlerts = prefs.patternAlerts.filter((p) => p.id !== id)
  emit()
  persistSoon()
}

export function setPatternAlertEnabled(id: string, enabled: boolean): void {
  if (enabled) forgetMatcher(id)
  prefs.patternAlerts = prefs.patternAlerts.map((p) => (p.id === id ? { ...p, enabled } : p))
  emit()
  persistSoon()
}
