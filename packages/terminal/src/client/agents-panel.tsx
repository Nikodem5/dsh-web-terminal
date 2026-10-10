// dsh-web-terminal — the right-hand panel listing Claude sub-agents, grouped by terminal.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { formatTokens } from './stats-format.ts'
import { displayName, focusWin, getRuntime } from './terminal-store.ts'
import type { WinState } from './terminal-store.ts'
import { groupSubagents, isRunning, shortModel, subagentElapsed, subagentName } from './subagents.ts'

/** Current time, re-read every second while `live` so running timers tick. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  return now
}

export function AgentsPanel({ wins }: { wins: readonly WinState[] }): ReactElement {
  const groups = groupSubagents(wins.map((w) => ({ id: w.id, name: displayName(w), tasks: getRuntime(w.id)?.subagents ?? [] })))
  const now = useNow(groups.some((g) => g.running > 0))

  return (
    <aside className="wt-agents">
      <div className="wt-side-head">
        <span>Sub-agents</span>
        <span className="wt-state">{groups.reduce((n, g) => n + g.running, 0)} running</span>
      </div>
      <div className="wt-side-list">
        {groups.length === 0 ? <div className="wt-side-empty">No sub-agents running</div> : null}
        {groups.map((g) => (
          <div key={g.id} className="wt-agents-group">
            <button type="button" className="wt-agents-head" title="Focus this terminal" onClick={() => { focusWin(g.id); getRuntime(g.id)?.term.focus() }}>
              <span className="wt-li-name">{g.name}</span>
              <span className="wt-state">{g.running > 0 ? `${g.running} running` : 'done'}</span>
            </button>
            {g.tasks.map((t) => {
              const running = isRunning(t)
              const elapsed = subagentElapsed(t, now)
              const model = shortModel(t.model)
              return (
                <div key={t.id} className="wt-agents-row" data-running={running} title={t.description || undefined}>
                  <span className="wt-dot" data-a={running ? 'working' : 'offline'} />
                  <span className="wt-li-main">
                    <span className="wt-li-name">{subagentName(t)}</span>
                    <span className="wt-li-sub">
                      {[model, elapsed, t.tokenCount === null ? null : `${formatTokens(t.tokenCount)} tok`].filter((v) => v !== null && v !== '').join(' · ')}
                    </span>
                  </span>
                  {t.agentType.length > 0 ? <span className="wt-agents-type">{t.agentType}</span> : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </aside>
  )
}
