// dsh-web-terminal — Overseer panel: ask a model what the terminals are doing, without touching them.
//
// A right-hand panel like the sub-agents one. Read-only by design: nothing here writes to a terminal;
// a cited terminal can only be focused. The answer is rendered from a parsed tree (overseer-markdown.ts),
// never as HTML.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { parseAnswer } from './overseer-markdown.ts'
import type { Inline } from './overseer-markdown.ts'
import {
  acceptOverseerNotice,
  askOverseer,
  clearOverseer,
  focusCited,
  getOverseerVersion,
  hydrateOverseer,
  isHiddenFromOverseer,
  overseer,
  setHiddenFromOverseer,
  setOverseerOpen,
  setOverseerSelection,
  stopOverseer,
  subscribeOverseer,
  syncOverseerHidden,
  toggleOverseer,
  togglePicked,
} from './overseer-state.ts'
import type { OverseerTurn } from './overseer-state.ts'
import { displayName } from './names.ts'
import { formatShortcut, matchShortcut, SHORTCUTS } from './shortcuts.ts'
import { ensureOverseerStyles } from './overseer-styles.ts'
import type { WinState } from './types.ts'

/** Re-render on every Overseer change. */
export function useOverseer(): typeof overseer {
  hydrateOverseer()
  useSyncExternalStore(subscribeOverseer, getOverseerVersion)
  return overseer
}

/** The registry shortcut (Ctrl/Cmd+Shift+O) toggles the panel while the Terminals page is mounted. */
export function useOverseerShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut('overseer', e)) return
      e.preventDefault()
      e.stopPropagation()
      hydrateOverseer()
      toggleOverseer()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

const shortcutText = (): string => {
  const s = SHORTCUTS.find((x) => x.id === 'overseer')
  return s === undefined ? '' : ` (${formatShortcut(s)})`
}

/** The toolbar toggle, placed next to the sub-agents one. */
export function OverseerToggle(): ReactElement {
  ensureOverseerStyles()
  const state = useOverseer()
  return (
    <button type="button" className="wt-btn wt-btn-overseer" data-on={state.open} title={`${state.open ? 'Hide' : 'Show'} the Overseer: ask what the terminals are doing${shortcutText()}`} onClick={() => toggleOverseer()}>
      Overseer{state.busy ? <span className="wt-btn-count">…</span> : null}
    </button>
  )
}

function InlineView({ parts, turn }: { parts: Inline[]; turn: OverseerTurn }): ReactElement {
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === 'bold') return <strong key={i}>{p.text}</strong>
        if (p.type === 'code') return <code key={i}>{p.text}</code>
        if (p.type === 'cite') {
          const known = turn.nums[p.num] !== undefined
          return known ? (
            <button key={i} type="button" className="wt-ov-cite" title={`Focus terminal ${p.num}`} onClick={() => focusCited(turn, p.num)}>{`T${p.num}`}</button>
          ) : (
            <span key={i}>{`[T${p.num}]`}</span>
          )
        }
        return <span key={i}>{p.text}</span>
      })}
    </>
  )
}

function Answer({ turn }: { turn: OverseerTurn }): ReactElement {
  const blocks = parseAnswer(turn.answer)
  const nodes: ReactNode[] = blocks.map((b, i) => {
    if (b.type === 'code') return <pre key={i} className="wt-ov-pre">{b.text}</pre>
    if (b.type === 'heading') return <div key={i} className="wt-ov-h"><InlineView parts={b.inlines} turn={turn} /></div>
    if (b.type === 'list') {
      const items = b.items.map((item, j) => <li key={j}><InlineView parts={item} turn={turn} /></li>)
      return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
    }
    return <p key={i}><InlineView parts={b.inlines} turn={turn} /></p>
  })
  return <div className="wt-ov-answer">{nodes}</div>
}

/** What the user should do about an error, by its code. */
function errorText(turn: OverseerTurn): string {
  if (turn.code === 'no-llm') return 'No model service is available in this app, so the Overseer cannot answer. Terminals keep working as usual.'
  if (turn.code === 'no-model') return 'No default model is selected. Choose one in the app\'s model settings, then ask again.'
  return turn.error ?? 'Something went wrong.'
}

function Turn({ turn }: { turn: OverseerTurn }): ReactElement {
  return (
    <div className="wt-ov-turn">
      <div className="wt-ov-q">{turn.question}</div>
      {turn.answer.length > 0 ? <Answer turn={turn} /> : null}
      {turn.status === 'streaming' && turn.answer.length === 0 ? <div className="wt-ov-note">Reading the terminals…</div> : null}
      {turn.status === 'stopped' ? <div className="wt-ov-note">Stopped.</div> : null}
      {turn.status === 'error' ? <div className="wt-ov-error" data-code={turn.code}>{errorText(turn)}</div> : null}
      {turn.cutShort === true ? <div className="wt-ov-note">The answer reached the model's length limit.</div> : null}
      {turn.truncated === true ? (
        <div className="wt-ov-note" title="The Overseer sends at most a fixed amount of terminal content per question">
          Some terminal content was left out to fit the size limit{turn.omitted !== undefined && turn.omitted.length > 0 ? ` (no output sent for ${turn.omitted.map((n) => `T${n}`).join(', ')})` : ''}. Pick terminals above to look at them in depth.
        </div>
      ) : null}
      {turn.model !== undefined && turn.status !== 'streaming' ? <div className="wt-ov-meta">{turn.model}</div> : null}
    </div>
  )
}

function Picker({ wins }: { wins: readonly WinState[] }): ReactElement {
  const selected = overseer.selected
  return (
    <div className="wt-ov-picker" aria-label="Terminals the Overseer looks at">
      <button type="button" className="wt-ov-chip" data-on={selected === null} title="Look at every terminal" onClick={() => setOverseerSelection(null)}>All</button>
      {wins.map((w, i) => {
        const hidden = isHiddenFromOverseer(w.id)
        const picked = selected?.includes(w.id) === true
        return (
          <span key={w.id} className="wt-ov-pick" data-hidden={hidden}>
            <button type="button" className="wt-ov-chip" data-on={picked} disabled={hidden} title={hidden ? 'Hidden from the Overseer' : picked ? 'Stop looking at this terminal in depth' : 'Look at this terminal in depth'} onClick={() => togglePicked(w.id)}>
              {`T${i + 1} ${displayName(w)}`}
            </button>
            <button type="button" className="wt-ov-eye" aria-pressed={hidden} title={hidden ? 'Show this terminal to the Overseer again' : 'Hide this terminal from the Overseer (nothing from it is sent)'} onClick={() => void setHiddenFromOverseer(w.id, !hidden)}>
              {hidden ? '⊘' : '◉'}
            </button>
          </span>
        )
      })}
    </div>
  )
}

export function OverseerPanel({ wins }: { wins: readonly WinState[] }): ReactElement {
  ensureOverseerStyles()
  const state = useOverseer()
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void syncOverseerHidden()
    inputRef.current?.focus()
  }, [])
  // Keep the newest answer in view while it streams.
  useEffect(() => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [state.version])

  const send = () => {
    const q = text.trim()
    if (q.length === 0 || state.busy || !state.noticeAccepted) return
    setText('')
    void askOverseer(q)
  }
  const visible = wins.filter((w) => !isHiddenFromOverseer(w.id)).length

  return (
    <aside className="wt-overseer" aria-label="Overseer">
      <div className="wt-side-head">
        <span>Overseer</span>
        <span className="wt-state">read-only · {visible} of {wins.length} visible</span>
        <span className="wt-grow" />
        <button type="button" className="wt-link" disabled={state.turns.length === 0} title="Forget this conversation" onClick={() => clearOverseer()}>Clear</button>
        <button type="button" className="wt-link" title="Close the Overseer" aria-label="Close the Overseer" onClick={() => setOverseerOpen(false)}>✕</button>
      </div>
      <Picker wins={wins} />
      <div className="wt-ov-list" ref={listRef}>
        {!state.noticeAccepted ? (
          <div className="wt-ov-notice" role="note">
            <b>Before you ask:</b> the Overseer sends what your terminals show (recent screen text, condensed agent conversations, folder and file names) to the model provider configured in this app, each time you ask. Obvious secrets such as API keys, tokens and private keys are replaced first, but not everything can be caught. Use ◉ next to a terminal to hide it from the Overseer. It only reads: it never types into, starts or stops a terminal.
            <div><button type="button" className="wt-btn" data-variant="primary" onClick={() => { acceptOverseerNotice(); inputRef.current?.focus() }}>I understand</button></div>
          </div>
        ) : null}
        {state.turns.length === 0 && state.noticeAccepted ? (
          <div className="wt-side-empty">Ask about your terminals, for example: “What is T3 doing?”, “Which terminals are waiting for me?”, “What did the agent in the api folder decide about caching?”</div>
        ) : null}
        {state.turns.map((t) => <Turn key={t.id} turn={t} />)}
      </div>
      <div className="wt-ov-input">
        <textarea
          ref={inputRef}
          className="wt-input"
          rows={2}
          value={text}
          placeholder={state.noticeAccepted ? 'Ask what the terminals are doing… (Enter to send)' : 'Read the note above first'}
          disabled={!state.noticeAccepted}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        {state.busy ? (
          <button type="button" className="wt-btn wt-btn-danger" onClick={() => stopOverseer()}>Stop</button>
        ) : (
          <button type="button" className="wt-btn" data-variant="primary" disabled={text.trim().length === 0 || !state.noticeAccepted} onClick={send}>Ask</button>
        )}
      </div>
    </aside>
  )
}
