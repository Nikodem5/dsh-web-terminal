// dsh-web-terminal — the "Send to…" picker (right-click on a selection, Ctrl+Shift+S) and its setting.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { closeSendMenu, getSendRequest, sendSelection, sendTargets, sendToNewClaude, setSendCodeBlock, subscribeSend } from './send-to.ts'
import { getPrefs, getRuntime, getVersion, subscribe } from './terminal-store.ts'
import { Pop } from './popover.tsx'

type Item = { kind: 'copy' } | { kind: 'target'; id: string } | { kind: 'new' }

/** The picker: Copy, the other terminals (agents first), a new Claude terminal. Arrows + Enter, Esc cancels. */
export function SendMenu(): ReactElement | null {
  const req = useSyncExternalStore(subscribeSend, getSendRequest, getSendRequest)
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const ref = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(0)
  const reqKey = req === null ? '' : `${req.sourceId}:${req.x}:${req.y}:${req.text.length}`

  // Take the keyboard on open; start on the first terminal rather than Copy.
  useEffect(() => {
    if (reqKey === '') return
    setActive(sendTargets(req?.sourceId ?? '').length > 0 ? 1 : 0)
    ref.current?.focus()
  }, [reqKey])
  useEffect(() => {
    if (reqKey === '') return
    const close = () => closeSendMenu()
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [reqKey])

  if (req === null) return null
  const targets = sendTargets(req.sourceId)
  const items: Item[] = [{ kind: 'copy' }, ...targets.map((t): Item => ({ kind: 'target', id: t.id })), { kind: 'new' }]

  const back = () => getRuntime(req.sourceId)?.term.focus()
  const choose = (item: Item) => {
    closeSendMenu()
    if (item.kind === 'copy') {
      navigator.clipboard?.writeText(req.text).catch(() => {})
      back()
    } else if (item.kind === 'new') sendToNewClaude(req.text, req.sourceId)
    else if (!sendSelection(req.text, item.id)) back()
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[Math.min(active, items.length - 1)]
      if (item !== undefined) choose(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSendMenu()
      back()
    } else if (e.key === 'Tab') e.preventDefault()
  }

  const row = (item: Item, index: number): ReactElement => {
    const t = item.kind === 'target' ? targets.find((x) => x.id === item.id) : undefined
    return (
      <button key={item.kind === 'target' ? item.id : item.kind} type="button" tabIndex={-1} className="wt-item wt-link wt-send-item" data-active={index === active} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}>
        {item.kind === 'copy' ? <span className="wt-grow">Copy</span> : null}
        {t !== undefined ? (
          <>
            <span className="wt-dot" data-a={t.activity} />
            <span className="wt-grow">{t.name}</span>
            {t.agent ? <span className="wt-state">agent</span> : null}
          </>
        ) : null}
        {item.kind === 'new' ? <span className="wt-grow">✦ New Claude terminal here</span> : null}
      </button>
    )
  }

  return (
    <Pop
      ref={ref}
      tabIndex={-1}
      className="wt-send"
      style={{ position: 'fixed', top: Math.min(req.y, window.innerHeight - 40 - items.length * 28), left: Math.max(4, Math.min(req.x, window.innerWidth - 260)), minWidth: 220, maxWidth: 320, zIndex: 3000 }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {row(items[0] as Item, 0)}
      <div className="wt-pop-title">Send to…</div>
      {targets.length === 0 ? <div className="wt-item" style={{ color: 'var(--wt-dim)' }}>No other terminal is connected.</div> : null}
      {items.slice(1).map((item, i) => row(item, i + 1))}
    </Pop>
  )
}

/** Aa menu block: how text sent to an agent is framed. */
export function SendSettings(): ReactElement {
  const prefs = getPrefs()
  return (
    <>
      <div className="wt-pop-title" data-section="sending">Sending</div>
      <label className="wt-item" style={{ cursor: 'pointer' }} title="Right-click a selection (or Ctrl+Shift+S) to send it. To an agent the text goes in a ``` block so it reads as quoted output; other terminals get it as is.">
        <input type="checkbox" checked={prefs.sendCodeBlock} onChange={(e) => setSendCodeBlock(e.target.checked)} />
        <span className="wt-grow">Wrap text sent to an agent in a code block</span>
      </label>
    </>
  )
}
