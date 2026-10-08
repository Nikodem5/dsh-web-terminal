// dsh-web-terminal — pure helpers for the stats bar: parsing the host payload and formatting.
//
// No DOM or React here so the unit tests can load this file directly.

/** One rate-limit window as the host reports it. Times are epoch ms. */
export interface LimitWindow {
  usedPct: number
  resetsAt: number
  outAt: number | null
}

export interface HostStats {
  limits: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null; sampledAt: number | null }
  cost: { totalUsd: number; terminals: number } | null
  tokens: { total: number; input: number; output: number; cacheRead: number; cacheCreation: number; asOf: number | null } | null
  statusLine: { enabled: boolean; reason: string | null }
}

/** A limits sample older than this is shown dimmed with its age. */
export const STALE_MS = 10 * 60_000

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOr = (v: unknown, d: number): number => (isNum(v) ? v : d)
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined)

function parseWindow(raw: unknown): LimitWindow | null {
  const w = obj(raw)
  if (w === undefined || !isNum(w.usedPct) || !isNum(w.resetsAt)) return null
  return { usedPct: w.usedPct, resetsAt: w.resetsAt, outAt: isNum(w.outAt) ? w.outAt : null }
}

/** Validate the `/stats` payload; anything unexpected (old host, bad body) yields undefined. */
export function parseStats(raw: unknown): HostStats | undefined {
  const r = obj(raw)
  if (r === undefined || r.ok !== true) return undefined
  const limits = obj(r.limits)
  const cost = obj(r.cost)
  const tokens = obj(r.tokens)
  const line = obj(r.statusLine)
  const sampledAt = limits?.sampledAt
  const asOf = tokens?.asOf
  return {
    limits: {
      fiveHour: parseWindow(limits?.fiveHour),
      sevenDay: parseWindow(limits?.sevenDay),
      sampledAt: isNum(sampledAt) ? sampledAt : null,
    },
    cost: cost === undefined ? null : { totalUsd: numOr(cost.totalUsd, 0), terminals: numOr(cost.terminals, 0) },
    tokens:
      tokens === undefined
        ? null
        : {
            total: numOr(tokens.total, 0),
            input: numOr(tokens.input, 0),
            output: numOr(tokens.output, 0),
            cacheRead: numOr(tokens.cacheRead, 0),
            cacheCreation: numOr(tokens.cacheCreation, 0),
            asOf: isNum(asOf) ? asOf : null,
          },
    statusLine: { enabled: line?.enabled !== false, reason: typeof line?.reason === 'string' ? line.reason : null },
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Local HH:mm. */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local weekday + HH:mm, e.g. `Thu 18:00`. */
export function formatDayClock(ms: number): string {
  return `${DAYS[new Date(ms).getDay()]} ${formatClock(ms)}`
}

/** Compact count: 812, 12.3k, 812M, 2.5B (one decimal under 100, none above, no trailing .0). */
export function formatTokens(n: number): string {
  if (!isNum(n) || n < 0) return '0'
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]
  for (const [size, suffix] of units) {
    if (n >= size) {
      const v = n / size
      return `${v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${suffix}`
    }
  }
  return String(Math.round(n))
}

export const formatUsd = (n: number): string => `$${(isNum(n) ? n : 0).toFixed(2)}`
export const formatPct = (n: number): string => `${Math.round(n)}%`

/** Limit usage severity: normal up to 50%, warn above 50, danger above 75. */
export function pctLevel(n: number): 'normal' | 'warn' | 'danger' {
  if (!isNum(n)) return 'normal'
  return n > 75 ? 'danger' : n > 50 ? 'warn' : 'normal'
}

/** `5m ago` / `2h ago` / `3d ago`. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export const isStale = (sampledAt: number | null, now: number): boolean => sampledAt !== null && now - sampledAt > STALE_MS

/** The 5h limit as display parts; `out` is separate so the bar can highlight it. */
export function describeFiveHour(w: LimitWindow): { main: string; label: string; pct: string; tail: string; level: ReturnType<typeof pctLevel>; out: string | null } {
  const tail = ` · resets ${formatClock(w.resetsAt)}`
  return { main: `5h ${formatPct(w.usedPct)}${tail}`, label: '5h', pct: formatPct(w.usedPct), tail, level: pctLevel(w.usedPct), out: w.outAt === null ? null : `out ~${formatClock(w.outAt)}` }
}

/** The 7d limit; the reset time goes to the tooltip instead of the line. */
export function describeSevenDay(w: LimitWindow): { main: string; label: string; pct: string; tail: string; level: ReturnType<typeof pctLevel>; out: string | null; title: string } {
  return { main: `7d ${formatPct(w.usedPct)}`, label: '7d', pct: formatPct(w.usedPct), tail: '', level: pctLevel(w.usedPct), out: w.outAt === null ? null : `out ~${formatDayClock(w.outAt)}`, title: `7-day limit resets ${formatDayClock(w.resetsAt)}` }
}

/** Tooltip with the token split. */
export function describeTokens(t: NonNullable<HostStats['tokens']>): string {
  const split = `input ${formatTokens(t.input)} / output ${formatTokens(t.output)} / cache read ${formatTokens(t.cacheRead)} / cache creation ${formatTokens(t.cacheCreation)}`
  return t.asOf === null ? split : `${split} (as of ${formatClock(t.asOf)})`
}
