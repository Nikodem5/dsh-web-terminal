// dsh-web-terminal — the one way the client puts text on the clipboard.

import { showNotice } from './notices.ts'

/** Copy `text` to the clipboard; a notice says so when that is not possible. */
export function copyText(text: string): void {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined) return showNotice('Copy failed: the clipboard is not available here')
  clipboard.writeText(text).catch(() => showNotice('Copy failed: the clipboard refused the text'))
}
