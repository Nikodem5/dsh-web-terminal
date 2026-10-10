// dsh-code-editor - light / dark following the app (measured like the terminal does).

import { luminanceOf } from '../../../shared/client/color.ts'

/** Whether the app currently paints a dark surface. */
export function isDarkSurface(): boolean {
  if (typeof document === 'undefined') return true
  if (document.documentElement.hasAttribute('data-ds-theme-source') || document.body.hasAttribute('data-ds-dark-theme')) {
    return document.body.hasAttribute('data-ds-dark-theme')
  }
  for (let el: Element | null = document.body; el !== null; el = el.parentElement) {
    const lum = luminanceOf(getComputedStyle(el).backgroundColor)
    if (lum !== undefined) return lum < 0.5
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme
  return scheme.length > 0 ? scheme.includes('dark') : window.matchMedia?.('(prefers-color-scheme: dark)').matches !== false
}
