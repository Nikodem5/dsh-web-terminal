// dsh-web-terminal — the stats bar: in the chat header and in the Terminals page toolbar.
//
// Registered into the harness list seat `conversation.session.header.utilities` (see index.ts)
// and rendered directly by the page. Both mounts share one poller and the module-level runtimes.
// Neighbours there are 28px-high round icon buttons in a flex row (gap 8px) with the tertiary
// label colour; the bar matches that height and colour. The component receives the standard
// session props (sessionId, useSessions, ...); it only uses `sessionCwd`, injected by index.ts,
// to remember which folder the chat session being viewed lives in (the dialog's fallback default).
//
// Agent counts read the module-level runtimes, which outlive the Terminals page, so they stay
// live while the chat is showing. They are created at plugin start (see start.ts), so the counts
// do not wait for the Terminals page to be opened.

import { useEffect, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { getStats, subscribeStats } from './stats.ts'
import { describeFiveHour, describeSevenDay, describeTokens, formatAge, formatTokens, formatUsd, isStale } from './stats-format.ts'
import { ensureStyles } from './styles.ts'
import { getVersion, noteSessionCwd, runningSubagents, runtimes, subscribe } from './terminal-store.ts'

const AGENT_KINDS = [
  { activity: 'working', label: 'working' },
  { activity: 'needs-you', label: 'needs you' },
  { activity: 'finished', label: 'finished' },
] as const

/** Number of terminals per activity. */
function countAgents(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const rt of runtimes.values()) counts[rt.activity] = (counts[rt.activity] ?? 0) + 1
  return counts
}

/** `5h 29% · resets 17:30` with the percentage in a fixed-width, severity-coloured field. */
function Limit({ d }: { d: { label: string; pct: string; tail: string; level: string } }): ReactElement {
  return (
    <>
      {d.label}{' '}
      <span className={d.level === 'normal' ? 'wt-pct' : `wt-pct wt-pct-${d.level}`}>{d.pct}</span>
      {d.tail}
    </>
  )
}

function Out({ text }: { text: string | null }): ReactElement | null {
  return text === null ? null : (
    <>
      {' · '}
      <span className="wt-stats-warn">{text}</span>
    </>
  )
}

/**
 * The compact one-line stats bar.
 * @param props - `sessionCwd` is present only in the chat header (injected by the entry).
 * @returns the bar, or null when there is nothing to show.
 */
export function StatsBar({ sessionCwd }: { sessionCwd?: () => string | undefined } = {}): ReactElement | null {
  ensureStyles()
  // Runs after every render of the header, so switching sessions records the new folder.
  useEffect(() => noteSessionCwd(sessionCwd?.()))
  useSyncExternalStore(subscribe, getVersion, getVersion)
  // Subscribing is what mounts the shared poller.
  const snap = useSyncExternalStore(subscribeStats, getStats, getStats)

  const counts = countAgents()
  const agents = AGENT_KINDS.filter((k) => (counts[k.activity] ?? 0) > 0)
  const stats = snap?.stats
  const limits = stats?.limits
  const sampledAt = limits?.sampledAt ?? null
  const stale = isStale(sampledAt, Date.now())
  const five = limits?.fiveHour ? describeFiveHour(limits.fiveHour) : null
  const seven = limits?.sevenDay ? describeSevenDay(limits.sevenDay) : null
  const lineOff = stats !== undefined && !stats.statusLine.enabled
  const offTitle = `Limit tracking is off: ${stats?.statusLine.reason ?? 'unknown reason'}`
  const cost = stats?.cost && (stats.cost.terminals > 0 || stats.cost.totalUsd > 0) ? stats.cost : null
  const tokens = stats?.tokens && stats.tokens.total > 0 ? stats.tokens : null

  const parts: ReactElement[] = []
  if (agents.length > 0) {
    parts.push(
      <span key="agents" className="wt-stats-group" title="Terminals by agent status">
        {agents.map((k) => (
          <span key={k.activity} className="wt-stats-item">
            <i className="wt-dot" data-a={k.activity} />
            {counts[k.activity]} {k.label}
          </span>
        ))}
      </span>,
    )
  }
  const subagents = runningSubagents()
  if (subagents > 0) {
    parts.push(
      <span key="subagents" className="wt-stats-item" title="Running Claude sub-agents across all terminals">
        {subagents} {subagents === 1 ? 'agent' : 'agents'}
      </span>,
    )
  }
  if (five !== null || seven !== null) {
    parts.push(
      <span
        key="limits"
        className="wt-stats-group"
        data-stale={stale}
        title={stale ? 'Limits come from the last Claude terminal that reported them' : lineOff ? offTitle : undefined}
      >
        {five !== null && (
          <span className="wt-stats-item">
            <Limit d={five} />
            <Out text={five.out} />
          </span>
        )}
        {seven !== null && (
          <span className="wt-stats-item" data-p="seven" title={seven.title}>
            <Limit d={seven} />
            <Out text={seven.out} />
          </span>
        )}
        {stale && sampledAt !== null && <span className="wt-stats-item">{`· ${formatAge(Date.now() - sampledAt)}`}</span>}
      </span>,
    )
  } else if (lineOff) {
    parts.push(
      <span key="limits" className="wt-stats-group" data-stale="true" title={offTitle}>
        <span className="wt-stats-item">limits n/a</span>
      </span>,
    )
  }
  if (cost !== null) {
    parts.push(
      <span key="cost" className="wt-stats-item" data-p="cost" title={`API-price equivalent across ${cost.terminals} open terminals`}>
        {formatUsd(cost.totalUsd)}
      </span>,
    )
  }
  if (tokens !== null) {
    parts.push(
      <span key="tokens" className="wt-stats-item" data-p="tokens" title={describeTokens(tokens)}>
        {formatTokens(tokens.total)} tok
      </span>,
    )
  }
  if (parts.length === 0) return null
  return <div className="wt-stats">{parts}</div>
}
