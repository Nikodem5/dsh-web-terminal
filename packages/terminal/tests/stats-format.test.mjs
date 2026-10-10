// Unit tests for the stats bar's pure helpers and the shared poller.
//
//   npm test   (or: node --test tests/stats-format.test.mjs)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { window } from './helpers/load-store.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = async (file) => {
  const out = await build({ entryPoints: [join(root, 'src', 'client', file)], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text + ' // ' + Math.random()).toString('base64')}`)
}

let f
before(async () => {
  f = await bundle('stats-format.ts')
})
after(() => window.close())

const local = (d, h, m) => new Date(2026, 9, d, h, m).getTime()

test('formatTokens: compact units', () => {
  assert.equal(f.formatTokens(0), '0')
  assert.equal(f.formatTokens(812), '812')
  assert.equal(f.formatTokens(12_300), '12.3k')
  assert.equal(f.formatTokens(12_000), '12k')
  assert.equal(f.formatTokens(812_000_000), '812M')
  assert.equal(f.formatTokens(2_500_000_000), '2.5B')
  assert.equal(f.formatTokens(-5), '0')
  assert.equal(f.formatTokens(NaN), '0')
})

test('clock helpers use local time', () => {
  assert.equal(f.formatClock(local(8, 14, 5)), '14:05')
  assert.equal(f.formatDayClock(local(8, 18, 0)), 'Thu 18:00') // 2026-10-08 is a Thursday
})

test('formatAge and staleness', () => {
  assert.equal(f.formatAge(5 * 60_000), '5m ago')
  assert.equal(f.formatAge(2 * 3600_000 + 1000), '2h ago')
  assert.equal(f.formatAge(72 * 3600_000), '3d ago')
  assert.equal(f.isStale(1000, 1000 + 10 * 60_000), false)
  assert.equal(f.isStale(1000, 1001 + 10 * 60_000), true)
  assert.equal(f.isStale(null, 1e12), false)
})

test('percentage severity thresholds are over 50 and over 75', () => {
  assert.equal(f.pctLevel(0), 'normal')
  assert.equal(f.pctLevel(50), 'normal')
  assert.equal(f.pctLevel(51), 'warn')
  assert.equal(f.pctLevel(75), 'warn')
  assert.equal(f.pctLevel(76), 'danger')
  assert.equal(f.pctLevel(100), 'danger')
  assert.equal(f.pctLevel(NaN), 'normal')
})

test('limit descriptions', () => {
  const five = f.describeFiveHour({ usedPct: 41.6, resetsAt: local(8, 14, 30), outAt: local(8, 13, 55) })
  assert.deepEqual(five, { main: '5h 42% · resets 14:30', label: '5h', pct: '42%', tail: ' · resets 14:30', level: 'normal', out: 'out ~13:55' })
  assert.equal(f.describeFiveHour({ usedPct: 10, resetsAt: local(8, 14, 30), outAt: null }).out, null)
  const seven = f.describeSevenDay({ usedPct: 63, resetsAt: local(9, 9, 0), outAt: local(8, 18, 0) })
  assert.equal(seven.main, '7d 63%')
  assert.equal(seven.level, 'warn')
  assert.equal(seven.out, 'out ~Thu 18:00')
  assert.equal(seven.title, '7-day limit resets Fri 09:00')
})

test('cost and token tooltip', () => {
  assert.equal(f.formatUsd(12.345), '$12.35')
  const tip = f.describeTokens({ total: 10, input: 1500, output: 2_000_000, cacheRead: 3_000_000_000, cacheCreation: 0, asOf: local(8, 9, 7) })
  assert.equal(tip, 'input 1.5k / output 2M / cache read 3B / cache creation 0 (as of 09:07)')
})

test('parseStats accepts the contract and rejects anything else', () => {
  const ok = f.parseStats({
    ok: true,
    limits: { fiveHour: { usedPct: 42, resetsAt: 1, outAt: null }, sevenDay: null, sampledAt: 5 },
    cost: { totalUsd: 1.5, terminals: 2 },
    tokens: { total: 9, input: 1, output: 2, cacheRead: 3, cacheCreation: 3, asOf: 7 },
    statusLine: { enabled: false, reason: 'node not on PATH' },
  })
  assert.equal(ok.limits.fiveHour.usedPct, 42)
  assert.equal(ok.limits.sevenDay, null)
  assert.equal(ok.limits.sampledAt, 5)
  assert.deepEqual(ok.statusLine, { enabled: false, reason: 'node not on PATH' })
  assert.equal(f.parseStats(undefined), undefined)
  assert.equal(f.parseStats({ ok: false }), undefined)
  assert.equal(f.parseStats('x'), undefined)
  const sparse = f.parseStats({ ok: true, limits: { fiveHour: { usedPct: 'x' } } })
  assert.equal(sparse.limits.fiveHour, null)
  assert.equal(sparse.cost, null)
  assert.equal(sparse.tokens, null)
  assert.equal(sparse.statusLine.enabled, true)
})

test('poller: one shared timer, stops when the last bar unmounts, tolerates 404', async () => {
  let calls = 0
  let status = 200
  globalThis.fetch = async () => {
    calls++
    return { ok: status === 200, json: async () => ({ ok: true, limits: { fiveHour: null, sevenDay: null, sampledAt: null }, cost: null, tokens: null, statusLine: { enabled: true, reason: null } }) }
  }
  const p = await bundle('stats.ts')
  const seen = []
  const a = p.subscribeStats(() => seen.push('a'))
  const b = p.subscribeStats(() => seen.push('b'))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(calls, 1, 'two mounted bars share a single immediate poll')
  assert.ok(p.getStats() !== null)
  a()
  b()
  const before = calls
  status = 404
  const c = p.subscribeStats(() => {})
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(calls, before + 1)
  assert.ok(p.getStats() !== null, 'one failure keeps the last good value')
  c()
})
