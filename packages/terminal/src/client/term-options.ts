// dsh-web-terminal — scrollback, cursor and copy-on-select settings, applied to every open terminal at once.

import { emit, persistSoon, prefs, runtimes } from './state.ts'
import { clampScrollback } from './term-prefs.ts'
import type { CursorStyle } from './term-prefs.ts'

/** The xterm options these settings control, for a terminal that is being created. */
export function termOptions(): { scrollback: number; cursorStyle: CursorStyle; cursorBlink: boolean } {
  return { scrollback: prefs.term.scrollback, cursorStyle: prefs.term.cursorStyle, cursorBlink: prefs.term.cursorBlink }
}

function applyAll(): void {
  const options = termOptions()
  for (const rt of runtimes.values()) {
    rt.term.options.scrollback = options.scrollback
    rt.term.options.cursorStyle = options.cursorStyle
    rt.term.options.cursorBlink = options.cursorBlink
  }
  emit()
  persistSoon()
}

export function setScrollback(lines: number): void {
  prefs.term.scrollback = clampScrollback(lines)
  applyAll()
}

export function setCursorStyle(style: CursorStyle): void {
  prefs.term.cursorStyle = style === 'bar' || style === 'underline' ? style : 'block'
  applyAll()
}

export function setCursorBlink(on: boolean): void {
  prefs.term.cursorBlink = on
  applyAll()
}

export function setCopyOnSelect(on: boolean): void {
  prefs.term.copyOnSelect = on
  emit()
  persistSoon()
}
