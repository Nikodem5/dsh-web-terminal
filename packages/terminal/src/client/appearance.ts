// dsh-web-terminal — appearance preferences applied to every live terminal.

import { DEFAULT_FONT, emit, persistSoon, prefs, runtimes } from './state.ts'
import { termTheme } from './theme.ts'
import { refit } from './runtime.ts'
import type { FontPrefs } from './types.ts'

/** Apply font preferences to every live terminal and refit them. */
export function setFont(patch: Partial<FontPrefs>): void {
  const next = { ...prefs.font, ...patch }
  next.size = Math.min(32, Math.max(8, Number(next.size) || DEFAULT_FONT.size))
  next.lineHeight = Math.min(2, Math.max(1, Number(next.lineHeight) || DEFAULT_FONT.lineHeight))
  next.letterSpacing = Math.min(2, Math.max(0, Math.round(Number(next.letterSpacing)) || 0))
  next.boldWeight = Math.min(900, Math.max(100, Number.isFinite(Number(next.boldWeight)) ? Math.round(Number(next.boldWeight) / 100) * 100 : DEFAULT_FONT.boldWeight))
  next.minContrast = Math.min(21, Math.max(1, Number(next.minContrast) || DEFAULT_FONT.minContrast))
  if (next.family.trim().length === 0) next.family = DEFAULT_FONT.family
  prefs.font = next
  prefs.fontCustom = true
  for (const rt of runtimes.values()) {
    rt.term.options.fontFamily = next.family
    rt.term.options.lineHeight = next.lineHeight
    rt.term.options.letterSpacing = next.letterSpacing
    rt.term.options.fontWeightBold = next.boldWeight
    rt.term.options.minimumContrastRatio = next.minContrast
    refit(rt)
  }
  emit()
  persistSoon()
}

/** Terminal background colour, so the window chrome around it can match instead of showing app-coloured margins. */
export function termBackground(): string {
  return termTheme().background ?? '#14161b'
}

export function setTermTheme(mode: 'dark' | 'light' | 'auto'): void {
  prefs.termTheme = mode
  for (const rt of runtimes.values()) rt.term.options.theme = termTheme()
  emit()
  persistSoon()
}

export function setAutoFont(on: boolean): void {
  prefs.autoFont = on
  for (const rt of runtimes.values()) refit(rt)
  emit()
  persistSoon()
}

export function setFitCols(cols: number): void {
  prefs.fitCols = Math.min(240, Math.max(40, Math.round(cols) || 100))
  for (const rt of runtimes.values()) refit(rt)
  emit()
  persistSoon()
}
