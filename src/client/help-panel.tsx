// dsh-web-terminal — the help panel (📖 in the toolbar, F1): shortcuts, mouse actions, what the
// colours and the stats bar mean, and live diagnostics. A popover like the Aa and Layouts menus;
// the content lives in shortcuts.ts (keys) and help-data.ts (the rest) so this file is layout only.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { getStats, subscribeStats } from './stats.ts'
import {
  ACTIVITY_ORDER,
  ACTIVITY_TITLE,
  ATTENTION_LEGEND,
  BLOCK_ACTIONS,
  COMMAND_ALERT_LEGEND,
  GUTTER_LEGEND,
  MOUSE_ACTIONS,
  SSH_HELP,
  STATS_LEGEND,
  buildDiagnostics,
  countConns,
  diagnosticRows,
} from './help-data.ts'
import type { DiagnosticsInput } from './help-data.ts'
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  displayName,
  filterShortcuts,
  formatShortcut,
  getFocusId,
  getPrefs,
  getVersion,
  getWins,
  hostInfo,
  integrationSeen,
  runtimes,
  subscribe,
} from './terminal-store.ts'

/** Inline book icon: currentColor, so it matches the other toolbar buttons in both themes. */
export function HelpIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

/** Everything the diagnostics need, read from the live state. */
function readDiagnostics(now: number): DiagnosticsInput {
  const statusLine = getStats()?.stats.statusLine
  const focusId = getFocusId()
  const focused = getWins().find((w) => w.id === focusId)
  return {
    version: hostInfo.version,
    platform: hostInfo.platform,
    node: hostInfo.node,
    claude: hostInfo.claude,
    ssh: hostInfo.ssh,
    statusLine,
    shellIntegration: getPrefs().shellIntegration,
    focused: focused === undefined ? null : { name: displayName(focused), markersSeen: integrationSeen(focused.id) === true },
    conns: countConns([...runtimes.values()].map((rt) => rt.conn)),
    sampledAt: getStats()?.stats.limits.sampledAt,
    now,
  }
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="wt-help-sec">
      <h4>{title}</h4>
      {children}
    </section>
  )
}

export function HelpPanel({ onClose }: { onClose: () => void }): ReactElement {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useSyncExternalStore(subscribeStats, getStats, getStats)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  // The sample age and the connection counts move without any store change: refresh now and then.
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [])
  // Capture phase so Esc closes the panel before anything underneath (a terminal, the find bar) sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const shown = filterShortcuts(SHORTCUTS, query)
  const diag = readDiagnostics(now)
  const copy = () => {
    const text = buildDiagnostics(diag)
    const done = (state: 'ok' | 'failed') => {
      setCopied(state)
      setTimeout(() => setCopied(null), 2000)
    }
    if (navigator.clipboard === undefined) return done('failed')
    navigator.clipboard.writeText(text).then(() => done('ok'), () => done('failed'))
  }

  return (
    <div className="wt-pop wt-help" data-right="true" role="dialog" aria-label="Help" onPointerDown={(e) => e.stopPropagation()}>
      <div className="wt-help-head">
        <input ref={inputRef} className="wt-input wt-grow" value={query} placeholder="Filter shortcuts…" aria-label="Filter shortcuts" onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="wt-hbtn" title="Close (Esc)" onClick={onClose}>✕</button>
      </div>
      <div className="wt-help-body">
        <Section title="Keyboard shortcuts">
          {shown.length === 0 ? <div className="wt-dim">No shortcut matches “{query}”.</div> : null}
          {SHORTCUT_GROUPS.map((group) => {
            const rows = shown.filter((s) => s.group === group)
            if (rows.length === 0) return null
            return (
              <div key={group} className="wt-help-group" data-group={group}>
                <div className="wt-pop-title">{group}</div>
                {rows.map((s) => (
                  <div key={s.id} className="wt-help-row" data-shortcut={s.id}>
                    <kbd className="wt-kbd">{formatShortcut(s)}</kbd>
                    <span>{s.desc}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </Section>

        <Section title="Mouse">
          {MOUSE_ACTIONS.map((m) => (
            <div key={m.how} className="wt-help-row">
              <span className="wt-help-how">{m.how}</span>
              <span>{m.what}</span>
            </div>
          ))}
          <div className="wt-pop-title">Command header</div>
          {BLOCK_ACTIONS.map((m) => (
            <div key={m.how} className="wt-help-row" data-block-action>
              <span className="wt-help-how">{m.how}</span>
              <span>{m.what}</span>
            </div>
          ))}
        </Section>

        <Section title="SSH terminals">
          {SSH_HELP.map((m) => (
            <div key={m.how} className="wt-help-row">
              <span className="wt-help-how">{m.how}</span>
              <span>{m.what}</span>
            </div>
          ))}
        </Section>

        <Section title="Status colours">
          {ACTIVITY_ORDER.map((a) => (
            <div key={a} className="wt-help-row wt-help-icon">
              <span className="wt-dot" data-a={a} />
              <span>{ACTIVITY_TITLE[a]}</span>
            </div>
          ))}
          <div className="wt-pop-title">Badges</div>
          {ATTENTION_LEGEND.map((a) => (
            <div key={a.level} className="wt-help-row wt-help-icon">
              <span className="wt-badge" data-level={a.level}>{a.badge}</span>
              <span>{a.what}</span>
            </div>
          ))}
          {COMMAND_ALERT_LEGEND.map((a) => (
            <div key={a.badge} className="wt-help-row wt-help-icon">
              <span className="wt-badge" data-level="quiet">{a.badge}</span>
              <span>{a.what}</span>
            </div>
          ))}
          <div className="wt-pop-title">Command bar (left edge of the output)</div>
          {GUTTER_LEGEND.map((g) => (
            <div key={g.state} className="wt-help-row wt-help-icon">
              <span className="wt-gutter-swatch" data-state={g.state} />
              <span>{g.what}</span>
            </div>
          ))}
        </Section>

        <Section title="Stats bar">
          {STATS_LEGEND.map((s) => (
            <div key={s.term} className="wt-help-row">
              <span className="wt-help-how">{s.term}</span>
              <span>{s.what}</span>
            </div>
          ))}
        </Section>

        <Section title="Diagnostics">
          {diagnosticRows(diag).map((r) => (
            <div key={r.label} className="wt-help-row" data-bad={r.bad === true}>
              <span className="wt-help-how">{r.label}</span>
              <span>{r.value}</span>
            </div>
          ))}
          <div className="wt-row">
            <button type="button" className="wt-btn" onClick={copy}>Copy diagnostics</button>
            {copied !== null ? <span className="wt-dim">{copied === 'ok' ? 'Copied' : 'Could not copy'}</span> : null}
          </div>
        </Section>
      </div>
    </div>
  )
}
