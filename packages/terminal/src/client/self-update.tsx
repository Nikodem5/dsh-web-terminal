// dsh-web-terminal — "Update from source" in the help panel: pull the clone these plugins were installed from,
// rebuild, reinstall, then relaunch the app. The host does the work (lib/self-update.js); this polls its status.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { runtimes } from './terminal-store.ts'

const UPDATE = '/api/dsh-web-terminal/update'
const RELAUNCH = '/api/dsh-web-terminal/relaunch'
const POLL_MS = 1000
/** Log lines shown under the buttons. */
const LOG_SHOWN = 14

interface UpdateStatus {
  available: boolean
  reason: string | null
  repo: string | null
  installed: string | null
  head: string | null
  branch: string | null
  canRelaunch: boolean
  relaunchReason: string | null
  running: boolean
  step: string | null
  log: string[]
  ok: boolean | null
  error: string | null
}

async function request(url: string, method: 'GET' | 'POST'): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { method, headers: { accept: 'application/json' } })
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

const short = (commit: string | null): string => (commit === null ? '?' : commit.slice(0, 7))

/** Terminals with something running: a restart ends them. */
function busyCount(): number {
  return [...runtimes.values()].filter((rt) => rt.activity === 'working' || rt.activity === 'needs-you' || rt.activity === 'running').length
}

export function UpdateSection(): ReactElement {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [restarting, setRestarting] = useState<string | null>(null)

  const load = async (method: 'GET' | 'POST' = 'GET'): Promise<void> => {
    const body = await request(UPDATE, method)
    if (body === null || typeof body.available !== 'boolean') return setFailed(true)
    setFailed(false)
    setStatus(body as unknown as UpdateStatus)
  }

  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    if (status?.running !== true) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.running])

  const relaunch = async (): Promise<void> => {
    const busy = busyCount()
    const warning = busy > 0 ? `${busy} terminal${busy === 1 ? ' is' : 's are'} still running something and will be closed. ` : ''
    if (!window.confirm(`${warning}Restart the app now? Saved terminals reopen after the restart.`)) return
    setRestarting('Restarting…')
    const body = await request(RELAUNCH, 'POST')
    if (body?.ok !== true) setRestarting(typeof body?.error === 'string' ? body.error : 'Could not restart the app')
  }

  if (failed) return <div className="wt-dim">The host does not answer (it may be older than this panel): restart the app.</div>
  if (status === null) return <div className="wt-dim">Checking…</div>

  const behind = status.installed !== null && status.head !== null && status.installed !== status.head
  return (
    <div className="wt-update">
      {status.available ? (
        <>
          <div className="wt-help-row">
            <span className="wt-help-how">Clone</span>
            <span>{status.repo}</span>
          </div>
          <div className="wt-help-row" data-bad={behind}>
            <span className="wt-help-how">Installed</span>
            <span>{short(status.installed)}{behind ? ` (clone is at ${short(status.head)} on ${status.branch ?? '?'})` : ` on ${status.branch ?? '?'}`}</span>
          </div>
        </>
      ) : (
        <div className="wt-dim">{status.reason}</div>
      )}
      <div className="wt-row">
        <button type="button" className="wt-btn" disabled={!status.available || status.running} title="git pull --ff-only, npm install, build, install into this profile" onClick={() => void load('POST')}>
          {status.running ? `Updating: ${status.step ?? '…'}` : 'Pull, build and install'}
        </button>
        <button type="button" className="wt-btn" data-on={status.ok === true} disabled={!status.canRelaunch || status.running || restarting === 'Restarting…'} title={status.relaunchReason ?? 'Close and reopen the app to load the installed version'} onClick={() => void relaunch()}>
          Restart app
        </button>
      </div>
      {status.ok === false ? <div className="wt-update-error">{status.error}</div> : null}
      {restarting !== null ? <div className="wt-dim">{restarting}</div> : null}
      {status.log.length > 0 ? <pre className="wt-update-log">{status.log.slice(-LOG_SHOWN).join('\n')}</pre> : null}
    </div>
  )
}
