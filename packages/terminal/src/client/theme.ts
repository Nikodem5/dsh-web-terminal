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

/** WCAG relative luminance of a `#rrggbb` colour (gamma-linearised, unlike the quick `luminanceOf`). */
export function wcagLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** WCAG contrast ratio (1..21) between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [wcagLuminance(a), wcagLuminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * The two palettes. Contrast against the background (checked in tests): every foreground and ANSI colour
 * except black is >= 4.5:1 (default text 15.7:1 dark / 18.5:1 light), so grey hint lines stay legible
 * even before xterm's minimumContrastRatio lifts them. Dark: VS Code Dark+ lifted where it was murky
 * (blue 3.7 -> 6.8, magenta 3.9 -> 6.0, red 3.5 -> 5.6, bright black 3.2 -> 5.9). Light: the yellow/green/cyan
 * that were 2.1-3.4 darkened to >= 4.5.
 */
export function termPalette(dark: boolean): Record<string, string> {
  return dark
    ? {
        background: '#14161b', foreground: '#eceff4', cursor: '#7c93ff', cursorAccent: '#14161b', selectionBackground: '#3b4a8a99',
        black: '#3a3f4b', red: '#f0605d', green: '#3fd68f', yellow: '#e5e510', blue: '#5aa0ff', magenta: '#d070d8', cyan: '#2ec4e6', white: '#dcdfe6',
        brightBlack: '#8b93a3', brightRed: '#ff7b7b', brightGreen: '#5ee8a6', brightYellow: '#fbfb6a', brightBlue: '#7db8ff', brightMagenta: '#e690ee', brightCyan: '#55d6f2', brightWhite: '#ffffff',
      }
    : {
        background: '#ffffff', foreground: '#111418', cursor: '#4d6bfe', cursorAccent: '#ffffff', selectionBackground: '#4d6bfe33',
        black: '#000000', red: '#cd3131', green: '#00802b', yellow: '#7a6e00', blue: '#0451a5', magenta: '#bc05bc', cyan: '#047a99', white: '#555555',
        brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#0f8a0f', brightYellow: '#8a6d00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#047a99', brightWhite: '#767676',
      }
}

/** xterm colours following the app's scheme at creation time. */
export function termTheme(): Record<string, string> {
  return termPalette(prefs.termTheme === 'auto' ? isDarkSurface() : prefs.termTheme === 'dark')
}
