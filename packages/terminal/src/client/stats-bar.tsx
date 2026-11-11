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
import { describeBuckets, describeFiveHour, describeSevenDay, describeTokens, formatAge, formatTokens, formatUsd, isStale } from './stats-format.ts'
import type { ProviderStats } from './stats-format.ts'
import { statsProviders } from './stats-providers.ts'
import { providerById, providerOfWin, providers } from './providers.ts'
import { ensureStyles } from './styles.ts'
import { getFocusId, getVersion, getWins, noteSessionCwd, runningSubagents, runtimes, subscribe } from './terminal-store.ts'

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

/** The limits, cost and tokens of one provider. */
function providerParts(id: string, s: ProviderStats, marked: boolean, offTitle: string | null): ReactElement[] {
  const provider = providerById(id)
  const name = provider?.label ?? id
  const mark = marked ? <span className="wt-stats-mark" title={name}>{provider?.glyph ?? id}</span> : null
  const out: ReactElement[] = []
  const stale = isStale(s.limits.sampledAt, Date.now())
  const five = s.limits.fiveHour ? describeFiveHour(s.limits.fiveHour) : null
  const seven = s.limits.sevenDay ? describeSevenDay(s.limits.sevenDay) : null
  const buckets = describeBuckets(s.limits.buckets)
  if (five !== null || seven !== null) {
    const staleTitle = `Limits come from the last ${name} terminal that reported them`
    out.push(
      <span key={`${id}-limits`} className="wt-stats-group" data-provider={id} data-stale={stale} title={stale ? staleTitle : (offTitle ?? buckets ?? undefined)}>
        {mark}
        {five !== null && (
          <span className="wt-stats-item">
            <Limit d={five} />
            <Out text={five.out} />
          </span>
        )}
        {seven !== null && (
          <span className="wt-stats-item" data-p="seven" title={buckets === null ? seven.title : `${seven.title}\n${buckets}`}>
            <Limit d={seven} />
            <Out text={seven.out} />
          </span>
        )}
        {stale && s.limits.sampledAt !== null && <span className="wt-stats-item">{`· ${formatAge(Date.now() - s.limits.sampledAt)}`}</span>}
      </span>,
    )
  } else if (offTitle !== null) {
    out.push(
      <span key={`${id}-limits`} className="wt-stats-group" data-provider={id} data-stale="true" title={offTitle}>
        {mark}
        <span className="wt-stats-item">limits n/a</span>
      </span>,
    )
  }
  const lead = out.length === 0 ? mark : null
  const cost = s.cost && (s.cost.terminals > 0 || s.cost.totalUsd > 0) ? s.cost : null
  if (cost !== null) {
    const what = s.cost?.estimated === true ? 'List-price estimate' : 'API-price equivalent'
    out.push(
      <span key={`${id}-cost`} className="wt-stats-item" data-p="cost" data-provider={id} title={`${what} across ${cost.terminals} open ${name} terminals`}>
        {lead}
        {formatUsd(cost.totalUsd)}
      </span>,
    )
  }
  const tokens = s.tokens && s.tokens.total > 0 ? s.tokens : null
  if (tokens !== null) {
    const title = tokens.scope === 'sessions' ? `Tokens in the open ${name} sessions: input ${formatTokens(tokens.input)} / output ${formatTokens(tokens.output)}` : describeTokens(tokens)
    out.push(
      <span key={`${id}-tokens`} className="wt-stats-item" data-p="tokens" data-provider={id} title={title}>
        {cost === null ? lead : null}
        {formatTokens(tokens.total)} tok
      </span>,
    )
  }
  return out
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
  const lineOff = stats !== undefined && !stats.statusLine.enabled
  const offTitle = `Limit tracking is off: ${stats?.statusLine.reason ?? 'unknown reason'}`

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
  if (stats !== undefined) {
    const wins = getWins()
    const focused = wins.find((w) => w.id === getFocusId())
    const shown = statsProviders(wins.map((w) => providerOfWin(w)?.id), focused === undefined ? undefined : providerOfWin(focused)?.id, stats.providers, providers.map((p) => p.id))
    // A mark per provider once more than one is shown, or when the one shown is not Claude (the bar used to be Claude's only).
    const marked = shown.length > 1 || shown.some((id) => id !== 'claude')
    for (const id of shown) parts.push(...providerParts(id, stats.providers[id], marked, id === 'claude' && lineOff ? offTitle : null))
  }
  if (parts.length === 0) return null
  return <div className="wt-stats">{parts}</div>
}
