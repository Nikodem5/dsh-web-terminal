// dsh-web-terminal — the "Terminal" block of the Aa menu: scrollback, cursor, copy on select.

import type { ReactElement } from 'react'
import { getPrefs } from './state.ts'
import { setCopyOnSelect, setCursorBlink, setCursorStyle, setScrollback } from './term-options.ts'
import { SCROLLBACK_MAX, SCROLLBACK_MIN, isCursorStyle } from './term-prefs.ts'

export function TerminalSettings(): ReactElement {
  const term = getPrefs().term
  return (
    <>
      <div className="wt-pop-title" data-section="terminal">Terminal</div>
      <label className="wt-field" title={`Lines kept above the screen in every terminal (${SCROLLBACK_MIN}-${SCROLLBACK_MAX}). More lines use more memory per terminal.`}>
        Scrollback (lines)
        <input
          className="wt-input"
          type="number"
          min={SCROLLBACK_MIN}
          max={SCROLLBACK_MAX}
          step={500}
          defaultValue={term.scrollback}
          key={term.scrollback}
          data-setting="scrollback"
          onBlur={(e) => setScrollback(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </label>
      <div className="wt-row">
        <label className="wt-field wt-grow">
          Cursor
          <select className="wt-input" value={term.cursorStyle} data-setting="cursor-style" onChange={(e) => { if (isCursorStyle(e.target.value)) setCursorStyle(e.target.value) }}>
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </label>
        <label className="wt-item" style={{ cursor: 'pointer', alignSelf: 'flex-end' }}>
          <input type="checkbox" checked={term.cursorBlink} data-setting="cursor-blink" onChange={(e) => setCursorBlink(e.target.checked)} />
          <span>Blink</span>
        </label>
      </div>
      <label className="wt-item" style={{ cursor: 'pointer' }} title="Copies the selection to the clipboard as soon as you finish selecting. It replaces what you copied before.">
        <input type="checkbox" checked={term.copyOnSelect} data-setting="copy-on-select" onChange={(e) => setCopyOnSelect(e.target.checked)} />
        <span className="wt-grow">Copy on select</span>
      </label>
    </>
  )
}
