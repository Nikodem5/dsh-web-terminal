// Usage store: limits, forecasts, session cost.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WINDOWS, createUsage, forecastOut } from '../lib/usage.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Payload as the status line delivers it (reset times in epoch seconds). */
const payload = ({ five, seven, cost } = {}) => ({
  ...(five || seven
    ? {
        rate_limits: {
          ...(five ? { five_hour: { used_percentage: five[0], resets_at: five[1] / 1000 } } : {}),
          ...(seven ? { seven_day: { used_percentage: seven[0], resets_at: seven[1] / 1000 } } : {}),
        },
      }
    : {}),
  ...(cost === undefined ? {} : { cost: { total_cost_usd: cost } }),
})

test('5h forecast: pace over the last hour predicts when 100% is reached', () => {
  const usage = createUsage()
  const resets = 5 * HOUR
  usage.ingest('t', payload({ five: [10, resets] }), 1 * HOUR)
  usage.ingest('t', payload({ five: [50, resets] }), 2 * HOUR)
  // 10% -> 50% over the last hour = 40%/h; the remaining 50% takes 1.25 h.
  const limits = usage.limits(2 * HOUR)
  assert.equal(limits.fiveHour.outAt, 2 * HOUR + 75 * MIN)
  assert.equal(limits.fiveHour.usedPct, 50)
  assert.equal(limits.fiveHour.resetsAt, resets)
  assert.equal(limits.sampledAt, 2 * HOUR)
})

test('5h forecast: null when the limit lasts until the reset', () => {
  const usage = createUsage()
  usage.ingest('t', payload({ five: [10, 5 * HOUR] }), 1 * HOUR)
  usage.ingest('t', payload({ five: [30, 5 * HOUR] }), 2 * HOUR) // 20%/h -> out at 5.5 h, after the reset
  assert.equal(usage.limits(2 * HOUR).fiveHour.outAt, null)
})

test('5h forecast: under 10 min of samples uses the pace since the window began', () => {
  const usage = createUsage()
  const resets = 5 * HOUR // window began at 0
  usage.ingest('t', payload({ five: [5, resets] }), 0)
  usage.ingest('t', payload({ five: [6, resets] }), 5 * MIN)
  // No sample is an hour old and the samples span 5 min: 6% in 5 min since the start.
  assert.equal(usage.limits(5 * MIN).fiveHour.outAt, Math.round(5 * MIN + (94 / 6) * 5 * MIN))
})

test('5h forecast: between 10 min of samples and an hour, the pace since the first sample', () => {
  const usage = createUsage()
  usage.ingest('t', payload({ five: [20, 6 * HOUR] }), 1 * HOUR)
  usage.ingest('t', payload({ five: [30, 6 * HOUR] }), 1 * HOUR + 30 * MIN)
  assert.equal(usage.limits(1 * HOUR + 30 * MIN).fiveHour.outAt, 1 * HOUR + 30 * MIN + 3.5 * HOUR) // 20%/h
})

test('forecast is null without pace: no growth, full, too early, or window already over', () => {
  const spec = WINDOWS.fiveHour
  const win = (usedPct, samples, resetsAt = 5 * HOUR) => ({ usedPct, resetsAt, samples })
  assert.equal(forecastOut(win(40, [[0, 40]]), 2 * HOUR, spec), null, 'flat since the start')
  assert.equal(forecastOut(win(100, [[0, 90], [HOUR, 100]]), 2 * HOUR, spec), null, 'already at 100')
  assert.equal(forecastOut(win(3, [[2 * MIN, 3]]), 3 * MIN, spec), null, 'under 5 min into the window')
  assert.equal(forecastOut(win(50, [[0, 0]]), 6 * HOUR, spec), null, 'the window has reset')
  assert.equal(forecastOut(win(10, [[0, 10], [HOUR, 10]]), 2 * HOUR, spec), null, 'zero pace')
})

test('7d forecast looks back 24 h', () => {
  const usage = createUsage()
  const resets = 7 * DAY
  usage.ingest('t', payload({ seven: [10, resets] }), 1 * DAY)
  usage.ingest('t', payload({ seven: [20, resets] }), 2 * DAY - 2 * HOUR)
  usage.ingest('t', payload({ seven: [30, resets] }), 2 * DAY)
  // At 2 days the level a day ago was 10%: 20% in 24 h, so 70% more takes 3.5 days.
  assert.equal(usage.limits(2 * DAY).sevenDay.outAt, 2 * DAY + 3.5 * DAY)
  // At 3 days that pace would hit 100% after the reset: no warning.
  usage.ingest('t', payload({ seven: [32, resets] }), 3 * DAY)
  assert.equal(usage.limits(3 * DAY).sevenDay.outAt, null)
})

test('a new window starts the forecast over; stragglers and jitter are handled', () => {
  const usage = createUsage()
  usage.ingest('t', payload({ five: [10, 5 * HOUR] }), 1 * HOUR)
  usage.ingest('t', payload({ five: [60, 5 * HOUR] }), 2 * HOUR)
  assert.ok(usage.limits(2 * HOUR).fiveHour.outAt !== null)
  // Jitter of a few seconds in resets_at is the same window: samples are kept.
  usage.ingest('t', payload({ five: [70, 5 * HOUR + 3000] }), 2 * HOUR + MIN)
  assert.equal(usage.serialize().fiveHour.samples.length, 3)
  // A sample from the finished window arriving late is ignored.
  assert.equal(usage.ingest('other', payload({ five: [99, 1 * HOUR] }), 3 * HOUR), false)
  assert.equal(usage.limits(3 * HOUR).fiveHour.usedPct, 70)
  // The next window: usage drops, history is gone, no pace yet.
  usage.ingest('t', payload({ five: [2, 10 * HOUR] }), 5 * HOUR + MIN)
  const five = usage.limits(5 * HOUR + MIN).fiveHour
  assert.deepEqual([five.usedPct, five.resetsAt, five.outAt], [2, 10 * HOUR, null])
  assert.deepEqual(usage.serialize().fiveHour.samples, [[5 * HOUR + MIN, 2]])
})

test('samples are deduplicated and an out-of-order lower value is ignored', () => {
  const usage = createUsage()
  usage.ingest('a', payload({ five: [10, 5 * HOUR] }), 1000)
  usage.ingest('b', payload({ five: [10, 5 * HOUR] }), 2000)
  usage.ingest('a', payload({ five: [12, 5 * HOUR] }), 3000)
  usage.ingest('b', payload({ five: [11, 5 * HOUR] }), 4000) // stale
  assert.deepEqual(usage.serialize().fiveHour.samples, [[1000, 10], [3000, 12]])
})

test('cost is the latest value per terminal, summed, dropped with the terminal', () => {
  const usage = createUsage()
  assert.deepEqual(usage.cost(), { totalUsd: 0, terminals: 0 })
  usage.ingest('a', payload({ cost: 1.5 }))
  usage.ingest('b', payload({ cost: 2 }))
  usage.ingest('a', payload({ cost: 0.25 })) // a new Claude run in terminal a: latest wins
  assert.deepEqual(usage.cost(), { totalUsd: 2.25, terminals: 2 })
  usage.ingest('b', {}) // no cost in the payload: keeps the last one
  usage.removeSession('b')
  assert.deepEqual(usage.cost(), { totalUsd: 0.25, terminals: 1 })
  usage.removeSession('nope')
})

test('malformed payloads are skipped without throwing', () => {
  const usage = createUsage()
  const bodies = [null, 7, 'x', [], {}, { rate_limits: 5 }, { rate_limits: { five_hour: { used_percentage: 'a', resets_at: 1 } } }, { cost: { total_cost_usd: -1 } }, { cost: { total_cost_usd: 'x' } }]
  for (const body of bodies) assert.equal(usage.ingest('t', body), false)
  assert.deepEqual(usage.limits(0), { fiveHour: null, sevenDay: null, sampledAt: null })
  assert.deepEqual(usage.cost(), { totalUsd: 0, terminals: 0 })
})

test('serialize / restore round-trips limits and survives garbage', () => {
  const usage = createUsage()
  usage.ingest('t', payload({ five: [10, 5 * HOUR], seven: [4, 7 * DAY] }), 1 * HOUR)
  usage.ingest('t', payload({ five: [50, 5 * HOUR], cost: 3 }), 2 * HOUR)
  const copy = createUsage()
  copy.restore(JSON.parse(JSON.stringify(usage.serialize())))
  assert.deepEqual(copy.limits(2 * HOUR), usage.limits(2 * HOUR))
  assert.equal(copy.cost().terminals, 0)
  const bad = createUsage()
  const junk = [null, 5, 'x', { fiveHour: { usedPct: 'a' }, sevenDay: { usedPct: 1, resetsAt: 2, samples: 'no' }, sampledAt: 'z' }]
  for (const item of junk) bad.restore(item)
  assert.deepEqual(bad.limits(0), { fiveHour: null, sevenDay: null, sampledAt: null })
})
