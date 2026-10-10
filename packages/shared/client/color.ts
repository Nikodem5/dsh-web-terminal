// Shared by the DSH plugins: colour maths with no dependency on plugin state.

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
