// dsh-web-terminal — usage store (host half).
//
// What the Claude status line reports, folded into what the stats bar shows:
//  - account limits (5-hour and 7-day windows): the newest used % and reset time, plus a
//    forecast of when the window runs out at the current pace;
//  - session cost, summed over the live terminals.
// (All-time tokens live in token-totals.js.)
//
// Pure state, no I/O: the host feeds it payloads and persists `serialize()` itself.
// Rate limits are account-wide, so every terminal reports the same numbers and they are
// merged into one series per window.

const MIN = 60_000
const HOUR = 60 * MIN

/**
 * Per-window forecast tuning. 5h mirrors the user's statusline.ps1: pace over the last
 * hour, or since the first sample when there is under 10 min of samples, or since the
 * window start when even that is missing.
 * 7d uses a 24 h lookback: an hour of a week-long window is mostly noise (usage comes in
 * bursts and the % only moves in ~1.7 h steps), while the whole week would hide a changed
 * habit; a day smooths a work session yet follows the week's rhythm. Its "too early"
 * thresholds scale with it (2 h of samples, 1 h of window).
 */
export const WINDOWS = {
  fiveHour: { key: 'five_hour', windowMs: 5 * HOUR, lookbackMs: HOUR, minSpanMs: 10 * MIN, minElapsedMs: 5 * MIN },
  sevenDay: { key: 'seven_day', windowMs: 7 * 24 * HOUR, lookbackMs: 24 * HOUR, minSpanMs: 2 * HOUR, minElapsedMs: HOUR },
}

/** `resets_at` of the same window jitters by seconds between calls; further apart means a different window. */
const SAME_WINDOW_MS = 120_000

/**
 * Predict when a window's usage reaches 100%.
 * @param win - {usedPct, resetsAt (ms), samples: [[timeMs, usedPct], ...]} with the newest sample last.
 * @param now - current time (ms).
 * @param spec - one entry of WINDOWS.
 * @returns epoch ms, or null when there is no pace to speak of, the pace is not positive, or the limit would outlast the window.
 */
export function forecastOut(win, now, spec) {
  if (win.usedPct >= 100 || win.resetsAt <= now) return null
  const { samples, usedPct } = win
  let rate = null // % per ms
  let before = null
  for (const sample of samples) if (sample[0] <= now - spec.lookbackMs) before = sample
  if (before !== null) {
    // Level at the start of the lookback (samples are only written on change) -> level now.
    rate = (usedPct - before[1]) / spec.lookbackMs
  } else if (samples.length > 0 && now - samples[0][0] >= spec.minSpanMs) {
    rate = (usedPct - samples[0][1]) / (now - samples[0][0])
  } else {
    const elapsed = now - (win.resetsAt - spec.windowMs)
    if (elapsed >= spec.minElapsedMs) rate = usedPct / elapsed
  }
  if (rate === null || !(rate > 0)) return null
  const eta = now + (100 - usedPct) / rate
  return eta >= win.resetsAt ? null : Math.round(eta)
}

/** A finite number, or undefined. */
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * @param options.now - clock (ms), injectable for tests.
 */
export function createUsage({ now = Date.now } = {}) {
  /** Window name -> {usedPct, resetsAt, samples} (absent until first seen). */
  const windows = {}
  let sampledAt = null
  /** Terminal id -> latest session cost in USD. */
  const costs = new Map()

  /** Fold one sample into a window; false when it was stale or changed nothing. */
  const update = (name, usedPct, resetsAt, at) => {
    const win = windows[name]
    if (win === undefined) {
      windows[name] = { usedPct, resetsAt, samples: [[at, usedPct]] }
      return true
    }
    if (resetsAt < win.resetsAt - SAME_WINDOW_MS) return false // a straggler from a finished window
    if (resetsAt > win.resetsAt + SAME_WINDOW_MS) win.samples = [] // a new window began: its history starts over
    else if (usedPct < win.usedPct) return false // the same window never goes down: an out-of-order sample
    const changed = win.usedPct !== usedPct || win.resetsAt !== resetsAt
    win.usedPct = usedPct
    win.resetsAt = resetsAt
    const last = win.samples[win.samples.length - 1]
    if (last === undefined || last[1] !== usedPct) win.samples.push([at, usedPct])
    return changed
  }

  return {
    /**
     * Take one status-line payload from a terminal. Defensive: anything malformed is skipped.
     * @param terminalId - the terminal that sent it (for the per-terminal cost).
     * @param body - parsed status-line JSON.
     * @returns whether state worth persisting changed.
     */
    ingest(terminalId, body, at = now()) {
      if (body === null || typeof body !== 'object') return false
      let changed = false
      const limits = body.rate_limits
      if (limits !== null && typeof limits === 'object') {
        for (const [name, spec] of Object.entries(WINDOWS)) {
          const entry = limits[spec.key]
          const pct = num(entry?.used_percentage)
          const resets = num(entry?.resets_at)
          if (pct === undefined || resets === undefined) continue
          if (update(name, Math.min(100, Math.max(0, pct)), resets * 1000, at)) changed = true
          sampledAt = at
        }
      }
      const cost = num(body.cost?.total_cost_usd)
      if (cost !== undefined && cost >= 0) costs.set(terminalId, cost)
      return changed
    },
    /** Forget a terminal's cost (its session was destroyed). */
    removeSession(terminalId) {
      costs.delete(terminalId)
    },
    /** Current limits with forecasts: {fiveHour, sevenDay, sampledAt}. */
    limits(at = now()) {
      const out = { sampledAt }
      for (const [name, spec] of Object.entries(WINDOWS)) {
        const win = windows[name]
        out[name] = win === undefined ? null : { usedPct: win.usedPct, resetsAt: win.resetsAt, outAt: forecastOut(win, at, spec) }
      }
      return out
    },
    /** Sum of the live terminals' session costs. */
    cost() {
      let totalUsd = 0
      for (const usd of costs.values()) totalUsd += usd
      return { totalUsd, terminals: costs.size }
    },
    /** JSON-safe snapshot of limits and forecast samples (cost is per-run and not kept). */
    serialize() {
      const out = { sampledAt }
      for (const name of Object.keys(WINDOWS)) {
        const win = windows[name]
        out[name] = win === undefined ? null : { usedPct: win.usedPct, resetsAt: win.resetsAt, samples: win.samples }
      }
      return out
    },
    /** Load a `serialize()` snapshot; garbage is ignored piecewise. */
    restore(saved) {
      if (saved === null || typeof saved !== 'object') return
      sampledAt = num(saved.sampledAt) ?? null
      for (const name of Object.keys(WINDOWS)) {
        const win = saved[name]
        const pct = num(win?.usedPct)
        const resets = num(win?.resetsAt)
        if (pct === undefined || resets === undefined || !Array.isArray(win.samples)) continue
        const samples = win.samples.filter((s) => Array.isArray(s) && num(s[0]) !== undefined && num(s[1]) !== undefined).map((s) => [s[0], s[1]])
        windows[name] = { usedPct: pct, resetsAt: resets, samples }
      }
    },
  }
}
