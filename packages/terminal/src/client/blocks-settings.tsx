// dsh-web-terminal — the shell-integration switch in the Aa menu.

import type { ReactElement } from 'react'
import { setShellIntegration } from './blocks.ts'
import { COMMAND_NOTIFY_CHOICES, setCommandNotifySeconds } from './block-notify.ts'
import { getPrefs } from './state.ts'

/** Command blocks and the real current folder need the shell to cooperate; this decides whether new shells are started with that. */
export function ShellIntegrationSettings(): ReactElement {
  const prefs = getPrefs()
  return (
    <>
      <div className="wt-pop-title" data-section="shell">Shell</div>
      <label className="wt-item" style={{ cursor: 'pointer' }} title="PowerShell and bash only. Adds an invisible hook to new shells (your files are not edited): a coloured bar per command, and the real current folder for clickable paths.">
        <input type="checkbox" checked={prefs.shellIntegration} onChange={(e) => setShellIntegration(e.target.checked)} />
        <span className="wt-grow">Mark commands and track the folder (applies to new shells)</span>
      </label>
    </>
  )
}

/** Alerts block: flag a long-running command that ended in a terminal you are not looking at. */
export function CommandAlertSettings(): ReactElement {
  const prefs = getPrefs()
  return (
    <>
      <label className="wt-item" title="When a command in a terminal you are not looking at ends after at least this long, the terminal gets a done / failed badge (failures also notify). Never for claude or other agents, nor full-screen programs. Needs shell integration.">
        <span className="wt-grow">Flag commands longer than</span>
        <select className="wt-input" value={prefs.commandNotifySec} onChange={(e) => setCommandNotifySeconds(Number(e.target.value))}>
          {COMMAND_NOTIFY_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? 'Off' : `${n} s`}</option>)}
        </select>
      </label>
    </>
  )
}
