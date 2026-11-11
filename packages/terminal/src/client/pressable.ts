// dsh-web-terminal — keyboard access for clickable rows that are not buttons (list rows, folder chips).

import type { KeyboardEvent } from 'react'

/**
 * Props that make a div/span focusable and operable with Enter or Space, like the click it already has.
 * Only a key pressed on the element itself counts: Enter inside an input or button within the row is theirs.
 */
export function pressable(activate: () => void, role: 'button' | 'option' = 'button'): { role: string; tabIndex: number; onKeyDown: (e: KeyboardEvent) => void } {
  return {
    role,
    tabIndex: 0,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
      e.preventDefault()
      e.stopPropagation()
      activate()
    },
  }
}
