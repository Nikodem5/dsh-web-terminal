// dsh-web-terminal — the pattern-alert list and its editor, a block of the Aa menu.

import { useState } from 'react'
import type { ReactElement } from 'react'
import { displayName } from './names.ts'
import { removePatternAlert, savePatternAlert, setPatternAlertEnabled } from './pattern-alerts.ts'
import { COOLDOWN_DEFAULT, COOLDOWN_MAX, NAME_MAX, PATTERNS_MAX, SCOPE_ALL, TEXT_MAX } from './pattern-alerts-core.ts'
import type { PatternAlert } from './pattern-alerts-core.ts'
import { getPrefs, getWins } from './state.ts'

const blank = (): Partial<PatternAlert> => ({ name: '', text: '', regex: false, caseSensitive: false, scope: SCOPE_ALL, enabled: true, level: 'urgent', cooldownSec: COOLDOWN_DEFAULT })

/** Where a pattern applies, for the list. */
function scopeLabel(scope: string): string {
  if (scope === SCOPE_ALL) return 'all terminals'
  const win = getWins().find((w) => w.id === scope)
  return win === undefined ? 'a closed terminal' : displayName(win)
}

/** Output triggers: text or a regular expression that raises a terminal's badge when a line of its output matches. */
export function PatternAlertSettings(): ReactElement {
  const patterns = getPrefs().patternAlerts
  const [draft, setDraft] = useState<Partial<PatternAlert> | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const wins = getWins()
  const edit = (patch: Partial<PatternAlert>) => setDraft((d) => ({ ...(d ?? blank()), ...patch }))
  const save = () => {
    const problem = savePatternAlert(draft ?? {})
    setError(problem)
    if (problem === undefined) setDraft(undefined)
  }
  return (
    <>
      <div className="wt-pop-title" data-section="patterns">Pattern alerts</div>
      <div className="wt-item" style={{ color: 'var(--wt-dim)', fontSize: 11 }}>
        Flag a terminal when a line of its output matches. Checked on finished lines, also while the window is minimized.
      </div>
      {patterns.map((p) => (
        <div key={p.id} className="wt-item" data-pattern={p.id}>
          <input type="checkbox" checked={p.enabled} title={p.enabled ? 'On' : 'Off'} onChange={(e) => setPatternAlertEnabled(p.id, e.target.checked)} />
          <span className="wt-grow" title={`${p.regex ? 'Regular expression' : 'Text'}: ${p.text}`}>
            {p.name.length > 0 ? p.name : p.text} <span className="wt-state">{scopeLabel(p.scope)}</span>
          </span>
          <button type="button" className="wt-link" onClick={() => { setError(undefined); setDraft({ ...p }) }}>Edit</button>
          <button type="button" className="wt-link" data-danger="true" title="Delete" onClick={() => removePatternAlert(p.id)}>✕</button>
        </div>
      ))}
      {draft === undefined ? (
        <button type="button" className="wt-btn" disabled={patterns.length >= PATTERNS_MAX} onClick={() => { setError(undefined); setDraft(blank()) }}>Add pattern…</button>
      ) : (
        <div className="wt-pattern-form" data-form="pattern">
          <label className="wt-field">
            Text to look for
            <input className="wt-input" autoFocus maxLength={TEXT_MAX} value={draft.text ?? ''} placeholder={draft.regex === true ? 'error|failed' : 'Do you want to proceed?'} onChange={(e) => edit({ text: e.target.value })} />
          </label>
          <label className="wt-item" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.regex === true} onChange={(e) => edit({ regex: e.target.checked })} />
            <span className="wt-grow">Regular expression</span>
          </label>
          <label className="wt-item" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.caseSensitive === true} onChange={(e) => edit({ caseSensitive: e.target.checked })} />
            <span className="wt-grow">Match case</span>
          </label>
          <label className="wt-field">
            Name on the badge (optional)
            <input className="wt-input" maxLength={NAME_MAX} value={draft.name ?? ''} onChange={(e) => edit({ name: e.target.value })} />
          </label>
          <label className="wt-field">
            Applies to
            <select className="wt-input" value={draft.scope ?? SCOPE_ALL} onChange={(e) => edit({ scope: e.target.value })}>
              <option value={SCOPE_ALL}>All terminals</option>
              {wins.map((w) => <option key={w.id} value={w.id}>{displayName(w)}</option>)}
              {draft.scope !== undefined && draft.scope !== SCOPE_ALL && !wins.some((w) => w.id === draft.scope) ? <option value={draft.scope}>A closed terminal</option> : null}
            </select>
          </label>
          <div className="wt-row">
            <label className="wt-field wt-grow">
              Badge
              <select className="wt-input" value={draft.level ?? 'urgent'} onChange={(e) => edit({ level: e.target.value === 'quiet' ? 'quiet' : 'urgent' })}>
                <option value="urgent">Urgent (chime, notification)</option>
                <option value="quiet">Quiet</option>
              </select>
            </label>
            <label className="wt-field wt-grow" title="The same pattern does not flag the same terminal again within this time.">
              Cooldown (s)
              <input className="wt-input" type="number" min={0} max={COOLDOWN_MAX} step={5} value={draft.cooldownSec ?? COOLDOWN_DEFAULT} onChange={(e) => edit({ cooldownSec: Number(e.target.value) })} />
            </label>
          </div>
          {error !== undefined ? <div className="wt-item" role="alert" style={{ color: 'var(--wt-danger)', fontSize: 11 }}>{error}</div> : null}
          <div className="wt-row">
            <button type="button" className="wt-btn" onClick={save}>Save</button>
            <button type="button" className="wt-btn" onClick={() => { setError(undefined); setDraft(undefined) }}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}
