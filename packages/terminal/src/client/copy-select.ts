// dsh-web-terminal — copy on select (an Aa setting, off by default) with a short on-terminal confirmation.

import { prefs } from './state.ts'
import type { Runtime } from './types.ts'

/** Wait this long after the last selection change, so dragging copies once, when the selection is settled. */
export const COPY_SETTLE_MS = 150
/** How long the confirmation stays. */
export const TOAST_MS = 1200

/** Put text on the clipboard; false when the browser or the app refuses (no permission, no secure context). */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A small note in the corner of the terminal; it replaces the previous one and removes itself. */
export function showToast(rt: Runtime, text: string, kind: 'ok' | 'fail'): void {
  rt.holder.querySelector('.wt-toast')?.remove()
  const el = document.createElement('div')
  el.className = 'wt-toast'
  el.dataset.kind = kind
  el.setAttribute('role', 'status')
  el.textContent = text
  rt.holder.appendChild(el)
  setTimeout(() => el.remove(), TOAST_MS)
}

/** Copy the current selection and say so. Returns what happened. */
export async function copySelection(rt: Runtime): Promise<'copied' | 'denied' | 'none'> {
  const text = rt.term.hasSelection() ? rt.term.getSelection() : ''
  if (text.trim().length === 0) return 'none'
  if (await writeClipboard(text)) {
    showToast(rt, 'Copied', 'ok')
    return 'copied'
  }
  showToast(rt, 'Copy blocked: clipboard not allowed', 'fail')
  return 'denied'
}

/** Watch the terminal's selection and copy it when the setting is on. */
export function installCopyOnSelect(rt: Runtime): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The text already copied for the selection that is still on screen: a re-select of the same text after a clear copies again.
  let copied = ''
  rt.term.onSelectionChange(() => {
    clearTimeout(timer)
    if (!rt.term.hasSelection()) {
      copied = ''
      return
    }
    if (!prefs.term.copyOnSelect) return
    timer = setTimeout(() => {
      if (rt.killed || !prefs.term.copyOnSelect || !rt.term.hasSelection()) return
      const text = rt.term.getSelection()
      if (text === copied) return
      copied = text
      void copySelection(rt)
    }, COPY_SETTLE_MS)
  })
}
