// dsh-web-terminal — the right-hand list of every open terminal: status dot,
// name (double-click to rename), folder, attention badge, drag to reorder,
// broadcast checkboxes, quick duplicate/close.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { requestClose } from './actions.ts'
import {
  baseName,
  displayName,
  duplicateWin,
  focusWin,
  getBroadcast,
  getRuntime,
  moveWin,
  renameWin,
  setBroadcastTargets,
  toggleBroadcastTarget,
} from './terminal-store.ts'
import type { Activity, WinState } from './terminal-store.ts'

const LABEL: Record<Activity, string> = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  exited: 'Exited',
  offline: 'Offline',
}

interface Props {
  wins: readonly WinState[]
  focusId: string | null
}

export function Sidebar({ wins, focusId }: Props): ReactElement {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const broadcast = getBroadcast()

  return (
    <aside className="wt-side">
      <div className="wt-side-head">
        <span>Terminals</span>
        <span className="wt-state">{wins.length}</span>
        <span className="wt-grow" />
        {broadcast.on ? (
          <>
            <button type="button" className="wt-link" onClick={() => setBroadcastTargets(wins.map((w) => w.id))}>All</button>
            <button type="button" className="wt-link" onClick={() => setBroadcastTargets([])}>None</button>
          </>
        ) : null}
      </div>
      <div
        className="wt-side-list"
        onDragOver={(e) => e.preventDefault()}
        onDrop={() => {
          if (dragId !== null) moveWin(dragId, null)
          setDragId(null)
          setOverId(null)
        }}
      >
        {wins.length === 0 ? <div className="wt-side-empty">Open a terminal to see it here.</div> : null}
        {wins.map((win) => {
          const rt = getRuntime(win.id)
          const activity: Activity = rt?.activity ?? 'offline'
          const name = displayName(win)
          const attn = rt?.attention === true
          return (
            <div
              key={win.id}
              className="wt-li"
              data-focused={focusId === win.id}
              data-attn={attn}
              data-over={overId === win.id && dragId !== win.id}
              draggable={renaming !== win.id}
              onDragStart={() => setDragId(win.id)}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOverId(win.id)
              }}
              onDrop={(e) => {
                e.stopPropagation()
                if (dragId !== null) moveWin(dragId, win.id)
                setDragId(null)
                setOverId(null)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOverId(null)
              }}
              onClick={() => {
                focusWin(win.id)
                getRuntime(win.id)?.term.focus()
              }}
              title={rt !== undefined && rt.attentionReason.length > 0 ? rt.attentionReason : win.cwd}
            >
              {broadcast.on ? (
                <input type="checkbox" checked={broadcast.ids.has(win.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleBroadcastTarget(win.id)} />
              ) : null}
              <span className="wt-dot" data-a={activity} />
              <span className="wt-li-main">
                {renaming === win.id ? (
                  <input
                    className="wt-name-input"
                    style={{ width: '100%' }}
                    autoFocus
                    defaultValue={name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      renameWin(win.id, e.target.value)
                      setRenaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
                    }}
                  />
                ) : (
                  <span
                    className="wt-li-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setRenaming(win.id)
                    }}
                  >
                    {name}
                  </span>
                )}
                <span className="wt-li-sub">
                  {LABEL[activity]} · {baseName(win.cwd) || win.cwd}
                  {win.pinned ? ' · pinned' : ''}
                </span>
              </span>
              {attn ? <span className="wt-badge">!</span> : null}
              <span className="wt-li-acts">
                <button type="button" className="wt-hbtn" title="Rename (empty = automatic name)" onClick={(e) => { e.stopPropagation(); setRenaming(win.id) }}>✎</button>
                <button type="button" className="wt-hbtn" title="Duplicate" onClick={(e) => { e.stopPropagation(); duplicateWin(win.id) }}>⧉</button>
                <button type="button" className="wt-hbtn" data-danger="true" title="Close" onClick={(e) => { e.stopPropagation(); requestClose([win.id]) }}>✕</button>
              </span>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
