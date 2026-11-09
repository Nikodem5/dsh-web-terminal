// dsh-web-terminal — a number input for the settings menu that lets you finish typing.
//
// The store's setters clamp to a range, so feeding them every keystroke turned "14" into 8 (for the
// "1"), then 84, then 32. This keeps what is typed as a draft and hands the number over when the field
// loses focus, on Enter, or when the field goes away; Escape drops the draft. The spinner arrows and
// the Up / Down keys (no typed character) apply at once.

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

interface Props {
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  /** Receives a finite number (the setter clamps it); never an empty or half-typed field. */
  onCommit: (value: number) => void
}

export function NumberField({ value, min, max, step, disabled, onCommit }: Props): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  // Read by the unmount cleanup, which would otherwise see the first render's draft and callback.
  const latest = useRef({ draft, onCommit })
  latest.current = { draft, onCommit }

  const commit = (text: string | null) => {
    setDraft(null)
    latest.current = { draft: null, onCommit }
    if (text === null || text.trim() === '') return
    const n = Number(text)
    if (Number.isFinite(n)) onCommit(n)
  }
  // A menu that closes while a value is half typed still applies it (an unmounting input gets no blur).
  useEffect(
    () => () => {
      const { draft: text, onCommit: apply } = latest.current
      if (text !== null && text.trim() !== '' && Number.isFinite(Number(text))) apply(Number(text))
    },
    [],
  )

  return (
    <input
      className="wt-input"
      type="number"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => {
        const typed = (e.nativeEvent as InputEvent).inputType !== undefined
        if (typed) setDraft(e.target.value)
        else commit(e.target.value)
      }}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(draft)
        else if (e.key === 'Escape' && draft !== null) {
          setDraft(null)
          latest.current = { draft: null, onCommit }
        }
      }}
    />
  )
}
