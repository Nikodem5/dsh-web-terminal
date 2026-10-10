// dsh-web-terminal — pure helpers for the sub-agents panel: validating the host's list,
// ordering, grouping and formatting.
//
// No DOM or React here so the unit tests can load this file directly.

/** One Claude sub-agent as the host reports it (times are epoch ms). */
export interface SubagentInfo {
  id: string
  agentType: string
  label: string
  description: string
  /** `running`, `completed` or anything newer the host invents; only `running` counts as live. */
  status: string
  model: string | null
  startTime: number | null
  endedAt: number | null
  tokenCount: number | null
  contextWindowSize: number | null
}

/** Sub-agents of one terminal, ready to render. */
export interface SubagentGroup {
  id: string
  name: string
  tasks: SubagentInfo[]
  running: number
}

const MAX_TASKS = 100
const MAX_TEXT = 300

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): number | null => (isNum(v) && v >= 0 ? v : null)
const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')

/** Validate a host list (untrusted); anything that is not a list, or an entry without an id, is dropped. */
export function parseSubagents(raw: unknown): SubagentInfo[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: SubagentInfo[] = []
  for (const item of raw) {
    if (out.length >= MAX_TASKS) break
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = text(r.id)
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      agentType: text(r.agentType),
      label: text(r.label),
      description: text(r.description),
      status: text(r.status) || 'running',
      model: typeof r.model === 'string' && r.model.length > 0 ? r.model.slice(0, 80) : null,
      startTime: numOrNull(r.startTime),
      endedAt: numOrNull(r.endedAt),
      tokenCount: numOrNull(r.tokenCount),
      contextWindowSize: numOrNull(r.contextWindowSize),
    })
  }
  return out
}

export const isRunning = (t: SubagentInfo): boolean => t.status === 'running'

/** Running first (oldest first), then the finished ones (latest first). */
export function sortSubagents(tasks: readonly SubagentInfo[]): SubagentInfo[] {
  const rank = (t: SubagentInfo) => (isRunning(t) ? 0 : 1)
  return [...tasks].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (isRunning(a)) return (a.startTime ?? Infinity) - (b.startTime ?? Infinity)
    return (b.endedAt ?? b.startTime ?? 0) - (a.endedAt ?? a.startTime ?? 0)
  })
}

/** One group per terminal that has sub-agents, in the terminals' own order. */
export function groupSubagents(entries: readonly { id: string; name: string; tasks: readonly SubagentInfo[] }[]): SubagentGroup[] {
  return entries
    .filter((e) => e.tasks.length > 0)
    .map((e) => ({ id: e.id, name: e.name, tasks: sortSubagents(e.tasks), running: e.tasks.filter(isRunning).length }))
}

export const countRunning = (lists: Iterable<readonly SubagentInfo[]>): number => {
  let n = 0
  for (const list of lists) for (const t of list) if (isRunning(t)) n++
  return n
}

/** Row title: the label, else the description, else the type. */
export const subagentName = (t: SubagentInfo): string => t.label || t.description || t.agentType || t.id

/** `claude-haiku-5-5` / `claude-haiku-4-5-20251001` -> `haiku-5-5` / `haiku-4-5`. */
export function shortModel(model: string | null): string {
  if (model === null) return ''
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** Elapsed time: 45s, 3m 12s, 1h 05m. Null when the start is unknown. */
export function subagentElapsed(t: SubagentInfo, now: number): string | null {
  if (t.startTime === null) return null
  const end = isRunning(t) ? now : (t.endedAt ?? now)
  const s = Math.max(0, Math.floor((end - t.startTime) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
