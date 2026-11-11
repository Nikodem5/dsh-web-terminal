// dsh-web-terminal — the Antigravity CLI's usage numbers (host half), behind the provider `usage` contract.
//
// Source: agy's status-line JSON (only with the opt-in integration, which runs lib/agy-statusline.mjs):
//  - `quota`: account buckets such as `gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly`, each with
//    `remaining_fraction` and `reset_time` (ISO). Used % = (1 - remaining_fraction) * 100. Buckets whose id
//    ends in `5h` are 5-hour windows, `weekly` ones weekly; the bar shows the most used of each kind and
//    lists every bucket in the tooltip. Same forecast as Claude's (lib/usage.js).
//  - `cost.total_usd`: list-price estimate for the session (per terminal, summed over live ones).
//  - `context_window.total_input_tokens` / `total_output_tokens`: the session's tokens (per terminal).
//  - `plan_tier`. The payload's `email` is never kept.
// agy keeps no readable all-time token total (its conversations are binary databases), so tokens here are
// the open sessions' only.

import { WINDOWS, forecastOut } from '../usage.js'

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const BUCKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** `resets` of one bucket jitters between calls; further apart means a new window. */
const SAME_WINDOW_MS = 120_000
const MAX_SAMPLES = 400

/** Which forecast spec a bucket id gets, or undefined when its period is unknown. */
export function bucketKind(id) {
  if (/5h$/i.test(id)) return 'fiveHour'
  if (/week(ly)?$/i.test(id)) return 'sevenDay'
  return undefined
}

/**
 * @param options.now - clock (ms), injectable for tests.
 * @returns {import('./index.js').UsageSource}
 */
export function createAntigravityUsage({ now = Date.now } = {}) {
  /** bucket id -> {usedPct, resetsAt, samples} */
  const buckets = new Map()
  let sampledAt = null
  let plan = null
  /** terminal id -> {usd, input, output} */
  const sessions = new Map()

  const update = (id, usedPct, resetsAt, at) => {
    const win = buckets.get(id)
    if (win === undefined) {
      buckets.set(id, { usedPct, resetsAt, samples: [[at, usedPct]] })
      return true
    }
    if (resetsAt < win.resetsAt - SAME_WINDOW_MS) return false
    if (resetsAt > win.resetsAt + SAME_WINDOW_MS) win.samples = []
    else if (usedPct < win.usedPct) return false
    const changed = win.usedPct !== usedPct || win.resetsAt !== resetsAt
    win.usedPct = usedPct
    win.resetsAt = resetsAt
    const last = win.samples.at(-1)
    if (last === undefined || last[1] !== usedPct) win.samples.push([at, usedPct])
    if (win.samples.length > MAX_SAMPLES) win.samples.splice(0, win.samples.length - MAX_SAMPLES)
    return changed
  }

  /** The most used bucket of one kind, with its forecast. */
  const worst = (kind, at) => {
    let best
    for (const [id, win] of buckets) {
      if (bucketKind(id) !== kind || win.resetsAt <= at) continue
      if (best === undefined || win.usedPct > best.win.usedPct) best = { id, win }
    }
    if (best === undefined) return null
    return { usedPct: best.win.usedPct, resetsAt: best.win.resetsAt, outAt: forecastOut(best.win, at, WINDOWS[kind]), bucket: best.id }
  }

  return {
    ingest(terminalId, body, at = now()) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
      let changed = false
      const quota = body.quota
      if (quota !== null && typeof quota === 'object' && !Array.isArray(quota)) {
        for (const [id, entry] of Object.entries(quota)) {
          if (!BUCKET_ID.test(id) || entry === null || typeof entry !== 'object' || entry.disabled === true) continue
          const remaining = num(entry.remaining_fraction)
          const resetsAt = Date.parse(entry.reset_time)
          if (remaining === undefined || !Number.isFinite(resetsAt)) continue
          const usedPct = Math.min(100, Math.max(0, (1 - remaining) * 100))
          if (update(id, Math.round(usedPct * 100) / 100, resetsAt, at)) changed = true
          sampledAt = at
        }
      }
      if (typeof body.plan_tier === 'string' && body.plan_tier.length <= 64 && body.plan_tier !== plan) {
        plan = body.plan_tier
        changed = true
      }
      const usd = num(body.cost?.total_usd)
      const input = num(body.context_window?.total_input_tokens)
      const output = num(body.context_window?.total_output_tokens)
      if (usd !== undefined || input !== undefined || output !== undefined) {
        const prev = sessions.get(terminalId) ?? { usd: 0, input: 0, output: 0 }
        sessions.set(terminalId, {
          usd: usd !== undefined && usd >= 0 ? usd : prev.usd,
          input: input !== undefined && input >= 0 ? input : prev.input,
          output: output !== undefined && output >= 0 ? output : prev.output,
        })
      }
      return changed
    },
    removeSession(terminalId) {
      sessions.delete(terminalId)
    },
    stats(at = now()) {
      let totalUsd = 0
      let input = 0
      let output = 0
      for (const s of sessions.values()) {
        totalUsd += s.usd
        input += s.input
        output += s.output
      }
      const list = [...buckets]
        .filter(([, win]) => win.resetsAt > at)
        .map(([id, win]) => ({ id, usedPct: win.usedPct, resetsAt: win.resetsAt }))
        .sort((a, b) => a.id.localeCompare(b.id))
      return {
        limits: { fiveHour: worst('fiveHour', at), sevenDay: worst('sevenDay', at), sampledAt, buckets: list },
        cost: { totalUsd, terminals: sessions.size, estimated: true },
        tokens: sessions.size === 0 ? null : { total: input + output, input, output, cacheRead: 0, cacheCreation: 0, asOf: null, scope: 'sessions' },
        plan,
      }
    },
    serialize() {
      return { sampledAt, plan, buckets: Object.fromEntries([...buckets].map(([id, win]) => [id, { usedPct: win.usedPct, resetsAt: win.resetsAt, samples: win.samples }])) }
    },
    restore(saved) {
      if (saved === null || typeof saved !== 'object') return
      sampledAt = num(saved.sampledAt) ?? null
      plan = typeof saved.plan === 'string' ? saved.plan : null
      const list = saved.buckets
      if (list === null || typeof list !== 'object') return
      for (const [id, win] of Object.entries(list)) {
        const pct = num(win?.usedPct)
        const resets = num(win?.resetsAt)
        if (!BUCKET_ID.test(id) || pct === undefined || resets === undefined || !Array.isArray(win.samples)) continue
        const samples = win.samples.filter((s) => Array.isArray(s) && num(s[0]) !== undefined && num(s[1]) !== undefined).map((s) => [s[0], s[1]])
        buckets.set(id, { usedPct: pct, resetsAt: resets, samples })
      }
    },
  }
}
