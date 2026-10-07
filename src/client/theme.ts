// dsh-web-terminal — colours: the xterm palette and measuring the app's own surface.

import { prefs } from './state.ts'

/** Relative luminance (0..1) of a computed CSS colour string, or undefined when it is transparent/unparseable. */
export function luminanceOf(color: string): number | undefined {
  const viaCanvas = (): number | undefined => {
    try {
      const ctx = document.createElement('canvas').getContext('2d')
      if (ctx === null || color.length === 0 || color === 'transparent') return undefined
      ctx.fillStyle = '#000'
      ctx.fillStyle = color
      const resolved = ctx.fillStyle
      return resolved.startsWith('rgb') && resolved !== color ? luminanceOf(resolved) : undefined
    } catch {
      return undefined
    }
  }
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/.exec(color)
  if (m === null) return viaCanvas()
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4])
  if (alpha < 0.5) return undefined
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number.parseFloat(v as string) / 255) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Whether the app currently paints a dark surface. Measured from the real background
 * (the theme's tokens can disagree with `color-scheme`), falling back to the declared scheme.
 * @param element - element whose own/ancestor background to sample; defaults to the body.
 */
export function isDarkSurface(element?: Element): boolean {
  if (typeof document === 'undefined') return true
  // The harness publishes its resolved scheme explicitly (theme presenter): authoritative when present.
  if (document.documentElement.hasAttribute('data-ds-theme-source') || document.body.hasAttribute('data-ds-dark-theme')) {
    return document.body.hasAttribute('data-ds-dark-theme')
  }
  for (let el: Element | null = element ?? document.body; el !== null; el = el.parentElement) {
    const lum = luminanceOf(getComputedStyle(el).backgroundColor)
    if (lum !== undefined) return lum < 0.5
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme
  return scheme.length > 0 ? scheme.includes('dark') : window.matchMedia?.('(prefers-color-scheme: dark)').matches !== false
}

/** xterm colours (VS Code Dark+/Light+ ANSI palettes) following the app's scheme at creation time. */
export function termTheme(): Record<string, string> {
  const dark = prefs.termTheme === 'auto' ? isDarkSurface() : prefs.termTheme === 'dark'
  return dark
    ? {
        background: '#14161b', foreground: '#d4d4d4', cursor: '#7c93ff', cursorAccent: '#14161b', selectionBackground: '#3b4a8a99',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
      }
    : {
        background: '#ffffff', foreground: '#1f2328', cursor: '#4d6bfe', cursorAccent: '#ffffff', selectionBackground: '#4d6bfe33',
        black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
        brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
      }
}
