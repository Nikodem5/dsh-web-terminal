// dsh-web-terminal — the help panel's "Antigravity integration" section: what it adds, its state, and the one
// explicit Install / Remove action (see integrations.ts and lib/agy-integration.js on the host).

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { describeIntegration, getIntegrations, integrationRunning, loadIntegrations, runIntegration } from './integrations.ts'

export const AGY_INTEGRATION_TEXT =
  'Optional. Adds a small agy plugin (hooks, installed with `agy plugin install`) and starts agy with a per-session --settings status line. ' +
  'Antigravity terminals then report the conversation id, changed files, and quota / cost in the stats bar, over a per-terminal secret, so output a program prints can no longer fake their status. ' +
  'Remove uninstalls the plugin. Nothing in your agy settings file is changed.'

export function AgyIntegrationSection(): ReactElement {
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    void loadIntegrations()
  }, [])
  const status = getIntegrations().antigravity
  const busy = integrationRunning() !== null || status?.busy === true
  const line = describeIntegration(status)
  const act = (action: 'install' | 'remove') => {
    setMessage(null)
    void runIntegration('antigravity', action).then((result) => {
      if (typeof result === 'string') setMessage(`Could not reach the host: ${result}`)
      else if (result.error !== null) setMessage(result.error)
      else setMessage(action === 'install' ? 'Installed. New Antigravity terminals use it; restart running ones.' : 'Removed.')
    })
  }
  return (
    <>
      <div className="wt-help-row">
        <span>{AGY_INTEGRATION_TEXT}</span>
      </div>
      <div className="wt-help-row" data-bad={line.bad}>
        <span className="wt-help-how">State</span>
        <span>{line.value}</span>
      </div>
      <div className="wt-row">
        {status?.enabled === true ? (
          <button type="button" className="wt-btn" disabled={busy} onClick={() => act('remove')}>Remove Antigravity integration</button>
        ) : (
          <button type="button" className="wt-btn" data-variant="primary" disabled={busy || status === undefined} onClick={() => act('install')}>Install Antigravity integration</button>
        )}
        {busy ? <span className="wt-dim">Working…</span> : message !== null ? <span className="wt-dim">{message}</span> : null}
      </div>
    </>
  )
}
