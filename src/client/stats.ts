// dsh-web-terminal — shared poller for the header stats bar.
//
// Several session headers can mount the bar at once; they share one timer and one result.
// Polling runs only while at least one bar is mounted and the page is visible.

import { parseStats } from './stats-format.ts'
import type { HostStats } from './stats-format.ts'

const ENDPOINT = '/api/dsh-web-terminal/stats'
const EVERY_MS = 5000
/** Failures in a row before the last good value is dropped (a single blip should not blank the bar). */
const MAX_FAILS = 3

export interface StatsSnapshot {
  stats: HostStats
  /** When it arrived (ms); a new object per poll so staleness text re-renders. */
  at: number
}

let snapshot: StatsSnapshot | null = null
let mounted = 0
let timer: ReturnType<typeof setInterval> | undefined
let fails = 0
let inflight = false
const listeners = new Set<() => void>()

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'
const emit = (): void => {
  for (const l of listeners) l()
}

/** Latest result, or null before the first success / after the host stopped answering. */
export const getStats = (): StatsSnapshot | null => snapshot

function fail(): void {
  if (++fails >= MAX_FAILS && snapshot !== null) {
    snapshot = null
    emit()
  }
}

/** One fetch. 404 / network errors (host not updated yet) just count as a failure. */
async function poll(): Promise<void> {
  if (inflight) return
  inflight = true
  try {
    const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
    if (!res.ok) return fail()
    const stats = parseStats(await res.json())
    if (stats === undefined) return fail()
    fails = 0
    snapshot = { stats, at: Date.now() }
    emit()
  } catch {
    fail()
  } finally {
    inflight = false
  }
}

/** Start or stop the timer to match "mounted and visible". */
function sync(): void {
  const want = mounted > 0 && visible()
  if (want && timer === undefined) {
    void poll()
    timer = setInterval(() => void poll(), EVERY_MS)
  } else if (!want && timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
}

/**
 * Subscribe a mounted bar; the first subscriber starts polling, the last one stops it.
 * @returns the unsubscribe function.
 */
export function subscribeStats(listener: () => void): () => void {
  listeners.add(listener)
  if (mounted++ === 0 && typeof document !== 'undefined') document.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    listeners.delete(listener)
    if (--mounted === 0) {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sync)
      sync()
    }
  }
}
