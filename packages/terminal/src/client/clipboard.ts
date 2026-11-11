// dsh-web-terminal — the one way the client puts text on the clipboard, with one kind of feedback:
// a short "Copied" note in the terminal the text came from, and a page notice when the clipboard refuses
// (a notice stays long enough to read and can be dismissed).

import { showNotice } from './notices.ts'
import type { Runtime } from './types.ts'

/** How long the "Copied" note stays. */
export const TOAST_MS = 1200

/** Put text on the clipboard; false when the browser or the app refuses (no permission, no secure context). */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
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

/**
 * Copy `text` and say what happened: a "Copied" note in `rt`'s terminal (when given), or a notice when the
 * clipboard is not available or refuses.
 * @returns whether the text is on the clipboard.
 */
export async function copyText(text: string, rt?: Runtime): Promise<boolean> {
  const done = await writeClipboard(text)
  if (done) {
    if (rt !== undefined && !rt.killed) showToast(rt, 'Copied', 'ok')
  } else {
    const missing = typeof navigator === 'undefined' || navigator.clipboard === undefined
    showNotice(missing ? 'Copy failed: the clipboard is not available here' : 'Copy failed: the clipboard refused the text')
  }
  return done
}
