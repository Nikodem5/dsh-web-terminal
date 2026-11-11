// dsh-web-terminal — colour tag per terminal window.

import { updateWin } from './state.ts'
import { cleanTag } from './tag-palette.ts'

/** Tag a window with a palette colour; an unknown id or undefined removes the tag. */
export function setWinColor(id: string, color: string | undefined): void {
  updateWin(id, { color: cleanTag(color) })
}
