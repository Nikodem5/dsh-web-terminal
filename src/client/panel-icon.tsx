// dsh-web-terminal — the sidebar glyph for the Terminals entry.
//
// The sidebar renders each panel row's icon with `{ size, active }` (16 when the sidebar is wide,
// 18 collapsed) inside a fixed glyph slot and draws the row colour itself, so the SVG fills with
// `currentColor`, an outline in the same weight as the harness's own glyphs, and nothing else.

import type { ReactElement } from 'react'

/**
 * A terminal-window outline with a prompt chevron.
 * @param props - the sidebar's icon share: the requested edge in pixels.
 * @returns the icon element.
 */
export function TerminalsIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
      <path d="M6 8.5l2.5 2L6 12.5" />
      <path d="M10.5 12.5h3.5" />
    </svg>
  )
}
