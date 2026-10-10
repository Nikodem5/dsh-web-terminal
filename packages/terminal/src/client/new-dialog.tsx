// dsh-web-terminal — the "New terminal" dialog: folder (with recents, favourites,
// native browse and the harness's Workspaces), shell, startup command and name; or, in the SSH tab,
// a host from ~/.ssh/config, a quick `user@host[:port]`, recent targets and a command to run remotely.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { browseFolder, canBrowse } from './actions.ts'
import type { WorkspaceChoice } from './workspaces.ts'
import { forgetRecent, forgetSsh, getPrefs, hostInfo, openTerminal, quickText, resolveSsh, sshKey, sshLabel, toggleFavourite, toggleSshFavourite } from './terminal-store.ts'
import type { SshTarget } from './terminal-store.ts'

interface Props {
  /** Preset startup command (e.g. `claude`). */
  startup?: string
  /** Which tab opens first. */
  mode?: 'local' | 'ssh'
  /** The harness's Workspaces (sidebar folders); empty when the shell does not expose them. */
  workspaces?: WorkspaceChoice[]
  onClose: () => void
}

const STARTUPS = [
  { label: 'None', value: '' },
  { label: 'claude', value: 'claude' },
  { label: 'claude --resume', value: 'claude --resume' },
  { label: 'claude --continue', value: 'claude --continue' },
]

export function NewTerminalDialog({ startup: presetStartup, mode: firstMode = 'local', workspaces = [], onClose }: Props): ReactElement {
  const prefs = getPrefs()
  const [mode, setMode] = useState(firstMode)
  const [cwd, setCwd] = useState(prefs.lastCwd || prefs.sessionCwd || workspaces[0]?.path || hostInfo.cwd || '')
  const [shell, setShell] = useState(prefs.lastShell || 'default')
  const [startup, setStartup] = useState(presetStartup ?? '')
  const [name, setName] = useState('')
  // SSH tab: a picked ~/.ssh/config alias or the typed user@host[:port] (typing wins), and the remote command.
  const [alias, setAlias] = useState<string | null>(null)
  const [quick, setQuick] = useState('')
  const [remote, setRemote] = useState('')
  const [tried, setTried] = useState(false)
  const [, force] = useState(0)

  const ssh = resolveSsh({ alias, quick, command: remote })
  // Unknown while the host has not answered: only a definite "not found" blocks.
  const sshReady = hostInfo.ssh?.available !== false
  const typing = quick.trim().length > 0
  const useTarget = (t: SshTarget) => {
    setAlias(t.host ?? null)
    setQuick(quickText(t))
    setRemote(t.command ?? '')
  }

  const open = () => {
    if (mode === 'ssh') {
      setTried(true)
      if (!ssh.ok || !sshReady) return
      openTerminal({ ssh: ssh.ssh, title: name.trim().length > 0 ? name.trim() : undefined })
      onClose()
      return
    }
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
  const sshHosts = hostInfo.ssh?.hosts ?? []
  const starred = prefs.sshFavourites.map(sshKey)
  const sshSaved = [...prefs.sshFavourites, ...prefs.sshRecents.filter((t) => !starred.includes(sshKey(t)))]
  // Quiet until the person has typed something or pressed Connect.
  const sshError = !ssh.ok && (tried || typing || remote.trim().length > 0) ? ssh.error : null
  const defaultName = ssh.ok ? `ssh: ${ssh.ssh.host ?? (ssh.ssh.target ?? '').replace(/^[^@]*@/, '')}` : 'Auto (ssh: host)'

  return (
    <div className="wt-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="wt-dialog" onKeyDown={onKey}>
        <h3>New terminal</h3>
        <span className="wt-row" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'local'} className="wt-chip" data-on={mode === 'local'} style={mode === 'local' ? { borderColor: 'var(--wt-accent)' } : undefined} onClick={() => setMode('local')}>Local</button>
          <button type="button" role="tab" aria-selected={mode === 'ssh'} className="wt-chip" data-on={mode === 'ssh'} style={mode === 'ssh' ? { borderColor: 'var(--wt-accent)' } : undefined} onClick={() => setMode('ssh')}>⇄ SSH</button>
        </span>
        {mode === 'ssh' ? (
          <>
            {!sshReady ? <span className="wt-note">The `ssh` client was not found on PATH. Install OpenSSH to use this tab.</span> : null}
            {sshHosts.length > 0 ? (
              <div className="wt-field">
                From ~/.ssh/config
                <div className="wt-folders" role="listbox" aria-label="SSH hosts">
                  {sshHosts.map((h) => {
                    const detail = `${h.user !== null ? `${h.user}@` : ''}${h.hostName ?? h.alias}${h.port !== null ? `:${h.port}` : ''}`
                    const picked = alias === h.alias && !typing
                    return (
                      <div key={h.alias} className="wt-folder wt-host" role="option" aria-selected={picked} data-sel={picked} title={detail} onClick={() => { setAlias(h.alias); setQuick('') }}>
                        <span className="wt-host-alias">{h.alias}</span>
                        <span className="wt-grow wt-dim">{detail}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <span className="wt-dim">{hostInfo.ssh === undefined ? 'Looking for hosts…' : 'No hosts in ~/.ssh/config: type user@host below.'}</span>
            )}
            <label className="wt-field">
              Or connect to (user@host or user@host:port)
              <input className="wt-input" autoFocus value={quick} placeholder="me@192.168.1.20:22" spellCheck={false} onChange={(e) => { setQuick(e.target.value); if (e.target.value.trim().length > 0) setAlias(null) }} />
            </label>
            {sshSaved.length > 0 ? (
              <div className="wt-folders" aria-label="Recent SSH targets">
                {sshSaved.map((t) => {
                  const on = starred.includes(sshKey(t))
                  const text = t.command !== undefined ? `${sshLabel(t)} · ${t.command}` : sshLabel(t)
                  return (
                    <div key={sshKey(t)} className="wt-folder" title={text} onClick={() => useTarget(t)}>
                      <button type="button" className="wt-star" data-on={on} title="Favourite this target" onClick={(e) => { e.stopPropagation(); toggleSshFavourite(t); force((n) => n + 1) }}>{on ? '★' : '☆'}</button>
                      <span className="wt-grow"><bdi>{text}</bdi></span>
                      {!on ? <button type="button" className="wt-link" title="Forget this target" onClick={(e) => { e.stopPropagation(); forgetSsh(t); force((n) => n + 1) }}>✕</button> : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
            <label className="wt-field">
              Run on connect (optional, runs on the remote machine)
              <input className="wt-input" value={remote} placeholder="e.g. cd ~/proj && claude" spellCheck={false} onChange={(e) => setRemote(e.target.value)} />
            </label>
            <label className="wt-field">
              Name (optional)
              <input className="wt-input" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
            </label>
            {sshError !== null ? <span className="wt-error" role="alert">{sshError}</span> : null}
            <span className="wt-dim">Keys and your ssh config work as usual. A password or passphrase is typed in the terminal and never stored.</span>
          </>
        ) : (
          <>
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
            {workspaces.length > 0 ? (
              <span className="wt-row" style={{ flexWrap: 'wrap' }}>
                <span className="wt-dim">Workspaces:</span>
                {workspaces.map((w) => (
                  <button key={w.path} type="button" className="wt-chip" data-on={w.path === cwd} style={w.path === cwd ? { borderColor: 'var(--wt-accent)' } : undefined} onClick={() => setCwd(w.path)} title={w.path}>{w.label}</button>
                ))}
              </span>
            ) : prefs.sessionCwd.length > 0 && prefs.sessionCwd !== cwd ? (
              // Fallback when the shell lists no Workspaces: the folder of the chat session viewed last.
              <span className="wt-row">
                <button type="button" className="wt-chip" onClick={() => setCwd(prefs.sessionCwd)} title={prefs.sessionCwd}>Use the last session’s workspace</button>
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
          </>
        )}
        <span className="wt-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="wt-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="wt-btn" data-variant="primary" disabled={mode === 'ssh' && !sshReady} onClick={open}>{mode === 'ssh' ? 'Connect' : 'Open'}</button>
        </span>
      </div>
    </div>
  )
}
