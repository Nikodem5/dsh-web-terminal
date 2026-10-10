// dsh-code-editor - the sidebar glyph for the Code entry.
//
// The sidebar renders each panel row's icon with `{ size, active }` and draws the row colour itself, so the SVG
// fills with `currentColor`, an outline in the same weight as the harness's own glyphs (and the terminal's).

import type { ReactElement } from 'react'

/** Code brackets with a slash: `</>`. */
export function CodeIcon({ size = 18 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 5.5L2.5 10L7 14.5" />
      <path d="M13 5.5L17.5 10L13 14.5" />
      <path d="M11.2 3.5L8.8 16.5" />
    </svg>
  )
}
