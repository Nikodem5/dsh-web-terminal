// dsh-web-terminal — copy on select (an Aa setting, off by default) and the shared "copy the selection" step
// that Ctrl+Shift+C uses too. The clipboard write and its feedback live in clipboard.ts.

import { copyText } from './clipboard.ts'
import { prefs } from './state.ts'
import type { Runtime } from './types.ts'

/** Wait this long after the last selection change, so dragging copies once, when the selection is settled. */
export const COPY_SETTLE_MS = 150

/** The text already copied for the selection that is still on screen, per terminal: neither path copies it twice at once. */
const copiedFor = new WeakMap<Runtime, string>()

/**
 * Copy the current selection and say so (see copyText). Returns what happened.
 * Nothing is written for an empty or blank selection: an empty write would wipe what the user copied elsewhere.
 */
export async function copySelection(rt: Runtime): Promise<'copied' | 'denied' | 'none'> {
  const text = rt.term.hasSelection() ? rt.term.getSelection() : ''
  if (text.trim().length === 0) return 'none'
  // Marked before the write, so a copy-on-select timer that fires meanwhile sees it and does not write again.
  copiedFor.set(rt, text)
  // A refused copy stays marked too: the same selection is not retried (and told about again) until it changes.
  return (await copyText(text, rt)) ? 'copied' : 'denied'
}

/** Watch the terminal's selection and copy it when the setting is on. */
export function installCopyOnSelect(rt: Runtime): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  rt.term.onSelectionChange(() => {
    clearTimeout(timer)
    if (!rt.term.hasSelection()) {
      copiedFor.delete(rt) // a re-select of the same text after a clear copies again
      return
    }
    if (!prefs.term.copyOnSelect) return
    timer = setTimeout(() => {
      if (rt.killed || !prefs.term.copyOnSelect || !rt.term.hasSelection()) return
      if (rt.term.getSelection() === copiedFor.get(rt)) return
      void copySelection(rt)
    }, COPY_SETTLE_MS)
  })
}
