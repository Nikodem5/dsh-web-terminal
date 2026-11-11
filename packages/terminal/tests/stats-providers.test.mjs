// Per-provider stats: parsing the /stats payload and choosing which providers the bar shows.
//
//   node --test tests/stats-providers.test.mjs

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = async (file) => {
  const out = await build({ entryPoints: [join(root, 'src', 'client', file)], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

let f
let p
before(async () => {
  f = await bundle('stats-format.ts')
  p = await bundle('stats-providers.ts')
})

const empty = { limits: { fiveHour: null, sevenDay: null, sampledAt: null }, cost: { totalUsd: 0, terminals: 0 }, tokens: null }
const agyStats = {
  limits: { fiveHour: { usedPct: 40, resetsAt: 2e12, outAt: null }, sevenDay: null, sampledAt: 1, buckets: [{ id: 'gemini-5h', usedPct: 40, resetsAt: 2e12 }, { id: 'bad' }] },
  cost: { totalUsd: 1.5, terminals: 1, estimated: true },
  tokens: { total: 10, input: 6, output: 4, cacheRead: 0, cacheCreation: 0, asOf: null, scope: 'sessions' },
  plan: 'Google AI Pro',
}

test('parseStats: per-provider numbers; an older host without them is read as Claude only', () => {
  const s = f.parseStats({ ok: true, ...empty, statusLine: { enabled: true, reason: null }, providers: { claude: empty, antigravity: agyStats } })
  assert.deepEqual(Object.keys(s.providers), ['claude', 'antigravity'])
  assert.equal(s.providers.antigravity.limits.fiveHour.usedPct, 40)
  assert.deepEqual(s.providers.antigravity.limits.buckets, [{ id: 'gemini-5h', usedPct: 40, resetsAt: 2e12 }])
  assert.equal(s.providers.antigravity.cost.estimated, true)
  assert.equal(s.providers.antigravity.tokens.scope, 'sessions')
  assert.equal(s.providers.antigravity.plan, 'Google AI Pro')
  const old = f.parseStats({ ok: true, ...empty, limits: { fiveHour: { usedPct: 3, resetsAt: 5 } }, statusLine: { enabled: true } })
  assert.deepEqual(Object.keys(old.providers), ['claude'])
  assert.equal(old.providers.claude.limits.fiveHour.usedPct, 3)
  assert.match(f.describeBuckets(s.providers.antigravity.limits.buckets), /^gemini-5h 40% · resets \w{3} \d\d:\d\d$/)
  assert.equal(f.describeBuckets([]), null)
})

test('statsProviders: the providers in use, focused first; with none in use, every one with numbers', () => {
  const stats = { claude: f.parseProviderStats({ ...empty, cost: { totalUsd: 2, terminals: 1 } }), antigravity: f.parseProviderStats(agyStats) }
  const order = ['claude', 'antigravity']
  assert.deepEqual(p.statsProviders(['claude', undefined], 'claude', stats, order), ['claude'])
  assert.deepEqual(p.statsProviders(['antigravity'], undefined, stats, order), ['antigravity'])
  assert.deepEqual(p.statsProviders(['claude', 'antigravity'], 'antigravity', stats, order), ['antigravity', 'claude'])
  assert.deepEqual(p.statsProviders(['antigravity', 'claude'], undefined, stats, order), ['claude', 'antigravity'])
  assert.deepEqual(p.statsProviders([undefined], undefined, stats, order), ['claude', 'antigravity'], 'plain shells only: both with numbers')
  const quiet = { claude: f.parseProviderStats(empty), antigravity: f.parseProviderStats(empty) }
  assert.deepEqual(p.statsProviders(['antigravity'], 'antigravity', quiet, order), [], 'nothing reported yet')
  assert.deepEqual(p.statsProviders(['claude'], undefined, quiet, order), ['claude'], 'Claude keeps its slot for "limits n/a"')
  assert.equal(p.hasNumbers(undefined), false)
})
