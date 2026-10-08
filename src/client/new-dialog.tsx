// dsh-web-terminal — the "New terminal" dialog: folder (with recents, favourites,
// native browse and the session's workspace), shell, startup command and name.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { browseFolder, canBrowse } from './actions.ts'
import { forgetRecent, getPrefs, hostInfo, openTerminal, toggleFavourite } from './terminal-store.ts'

interface Props {
  /** Preset startup command (e.g. `claude`). */
  startup?: string
  /** Folder of the DSH session this view belongs to, when known. */
  sessionCwd?: string
  onClose: () => void
}

const STARTUPS = [
  { label: 'None', value: '' },
  { label: 'claude', value: 'claude' },
  { label: 'claude --resume', value: 'claude --resume' },
  { label: 'claude --continue', value: 'claude --continue' },
]

export function NewTerminalDialog({ startup: presetStartup, sessionCwd, onClose }: Props): ReactElement {
  const prefs = getPrefs()
  const [cwd, setCwd] = useState(prefs.lastCwd || sessionCwd || hostInfo.cwd || '')
  const [shell, setShell] = useState(prefs.lastShell || 'default')
  const [startup, setStartup] = useState(presetStartup ?? '')
  const [name, setName] = useState('')
  const [, force] = useState(0)

  const open = () => {
    openTerminal({
      cwd: cwd.trim(),
      shell,
      startup: startup.trim().length > 0 ? startup.trim() : undefined,
      title: name.trim().length > 0 ? name.trim() : undefined,
    })
    onClose()
  }
  const onKey = (e: React.KeyboardEvent) => {
    // Enter on a button must press that button (Cancel, Browse, star...), not open the terminal.
    if (e.key === 'Enter') {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT') open()
    } else if (e.key === 'Escape') onClose()
  }
  const folders = [...prefs.favourites, ...prefs.recents.filter((p) => !prefs.favourites.includes(p))]
  const shells = hostInfo.shells ?? []

  return (
    <div className="wt-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="wt-dialog" onKeyDown={onKey}>
        <h3>New terminal</h3>
        <label className="wt-field">
          Start in folder
          <span className="wt-row">
            <input className="wt-input wt-grow" autoFocus value={cwd} placeholder={hostInfo.cwd ?? 'Folder path'} onChange={(e) => setCwd(e.target.value)} />
            {canBrowse() ? (
              <button type="button" className="wt-btn" onClick={() => { void browseFolder().then((picked) => { if (picked !== null) setCwd(picked) }) }}>Browse…</button>
            ) : null}
            <button type="button" className="wt-star" data-on={prefs.favourites.includes(cwd)} title="Favourite this folder" onClick={() => { toggleFavourite(cwd.trim()); force((n) => n + 1) }}>★</button>
          </span>
        </label>
        {sessionCwd !== undefined && sessionCwd !== cwd ? (
          <span className="wt-row">
            <button type="button" className="wt-chip" onClick={() => setCwd(sessionCwd)} title={sessionCwd}>Use this session’s workspace</button>
          </span>
        ) : null}
        {folders.length > 0 ? (
          <div className="wt-folders">
            {folders.map((p) => (
              <div key={p} className="wt-folder" onClick={() => setCwd(p)} title={p}>
                <button type="button" className="wt-star" data-on={prefs.favourites.includes(p)} onClick={(e) => { e.stopPropagation(); toggleFavourite(p); force((n) => n + 1) }}>{prefs.favourites.includes(p) ? '★' : '☆'}</button>
                <span className="wt-grow"><bdi>{p}</bdi></span>
                {!prefs.favourites.includes(p) ? (
                  <button type="button" className="wt-link" title="Forget this folder" onClick={(e) => { e.stopPropagation(); forgetRecent(p); force((n) => n + 1) }}>✕</button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="wt-row">
          <label className="wt-field wt-grow">
            Shell
            <select className="wt-input" value={shell} onChange={(e) => setShell(e.target.value)}>
              <option value="default">Default</option>
              {shells.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="wt-field wt-grow">
            Name (optional)
            <input className="wt-input" value={name} placeholder="Auto (from the program)" onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <label className="wt-field">
          Startup command (typed once when the shell starts)
          <input className="wt-input" value={startup} placeholder="e.g. claude" onChange={(e) => setStartup(e.target.value)} />
        </label>
        <span className="wt-row" style={{ flexWrap: 'wrap' }}>
          {STARTUPS.map((s) => (
            <button key={s.label} type="button" className="wt-chip" data-on={startup === s.value} style={startup === s.value ? { borderColor: 'var(--wt-accent)' } : undefined} onClick={() => setStartup(s.value)}>{s.label}</button>
          ))}
        </span>
        <span className="wt-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="wt-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wt-btn" data-variant="primary" onClick={open}>Open</button>
        </span>
      </div>
    </div>
  )
}
