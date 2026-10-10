// dsh-web-terminal — the shell-integration switch in the Aa menu.

import type { ReactElement } from 'react'
import { setShellIntegration } from './blocks.ts'
import { getPrefs } from './state.ts'

/** Command blocks and the real current folder need the shell to cooperate; this decides whether new shells are started with that. */
export function ShellIntegrationSettings(): ReactElement {
  const prefs = getPrefs()
  return (
    <>
      <div className="wt-pop-title">Shell integration</div>
      <label className="wt-item" style={{ cursor: 'pointer' }} title="PowerShell and bash only. Adds an invisible hook to new shells (your files are not edited): a coloured bar per command, and the real current folder for clickable paths.">
        <input type="checkbox" checked={prefs.shellIntegration} onChange={(e) => setShellIntegration(e.target.checked)} />
        <span className="wt-grow">Mark commands and track the folder (applies to new shells)</span>
      </label>
    </>
  )
}
