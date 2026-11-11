// dsh-web-terminal — the colour picker row in a window's ⋯ menu.

import type { ReactElement } from 'react'
import { TAG_COLORS } from './tag-palette.ts'
import { setWinColor } from './tags.ts'

export function ColorTagRow({ id, color, onPick }: { id: string; color: string | undefined; onPick?: () => void }): ReactElement {
  const pick = (next: string | undefined) => {
    setWinColor(id, next)
    onPick?.()
  }
  return (
    <div className="wt-tags" role="group" aria-label="Colour tag" data-act="colour-tag">
      <button type="button" className="wt-swatch" data-none="true" aria-pressed={color === undefined} aria-label="No colour" title="No colour" onClick={() => pick(undefined)} />
      {TAG_COLORS.map((c) => (
        <button key={c.id} type="button" className="wt-swatch" style={{ ['--wt-tag' as string]: c.hex }} aria-pressed={color === c.id} aria-label={c.label} title={c.label} onClick={() => pick(c.id)} />
      ))}
    </div>
  )
}
