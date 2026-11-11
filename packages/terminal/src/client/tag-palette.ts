// dsh-web-terminal — the colour tags a terminal can carry. A tag is stored as its id (never a raw colour),
// so a damaged or hand-edited value can only ever be one of these.

export interface TagColor {
  id: string
  label: string
  hex: string
}

export const TAG_COLORS: readonly TagColor[] = [
  { id: 'red', label: 'Red', hex: '#ef4444' },
  { id: 'orange', label: 'Orange', hex: '#f97316' },
  { id: 'yellow', label: 'Yellow', hex: '#eab308' },
  { id: 'green', label: 'Green', hex: '#22c55e' },
  { id: 'teal', label: 'Teal', hex: '#14b8a6' },
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'purple', label: 'Purple', hex: '#a855f7' },
  { id: 'pink', label: 'Pink', hex: '#ec4899' },
]

/** The id when it names a palette colour, otherwise undefined. */
export function cleanTag(value: unknown): string | undefined {
  return typeof value === 'string' && TAG_COLORS.some((c) => c.id === value) ? value : undefined
}

/** Attributes for an element that carries a tag: `data-tag` for the stylesheet and the colour as a variable. Empty without a tag. */
export function tagProps(color: string | undefined): { 'data-tag'?: string; style?: Record<string, string> } {
  const tag = TAG_COLORS.find((c) => c.id === color)
  return tag === undefined ? {} : { 'data-tag': tag.id, style: { '--wt-tag': tag.hex } }
}
