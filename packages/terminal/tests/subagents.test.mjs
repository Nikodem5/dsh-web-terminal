// Unit tests for the sub-agents panel's pure helpers.
//
//   npm test   (or: node --test tests/subagents.test.mjs)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let m
before(async () => {
  const out = await build({ entryPoints: [join(root, 'src', 'client', 'subagents.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' })
  m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
})

const t = (over) => ({ id: 'x', agentType: 'Explore', label: 'L', description: '', status: 'running', model: null, startTime: 1000, endedAt: null, tokenCount: null, contextWindowSize: null, ...over })

test('parseSubagents validates untrusted input', () => {
  assert.deepEqual(m.parseSubagents(undefined), [])
  assert.deepEqual(m.parseSubagents({}), [])
  const list = m.parseSubagents([{ id: 'a', status: 'running', startTime: 5, tokenCount: -1, model: '' }, { id: 'a' }, { id: 7 }, null, { label: 'no id' }, { id: 'b', startTime: 'x', tokenCount: 9 }])
  assert.deepEqual(list.map((x) => x.id), ['a', 'b'])
  assert.equal(list[0].startTime, 5)
  assert.equal(list[0].tokenCount, null)
  assert.equal(list[0].model, null)
  assert.equal(list[1].startTime, null)
  assert.equal(list[1].status, 'running')
  assert.equal(list[1].tokenCount, 9)
  assert.equal(m.parseSubagents(Array.from({ length: 500 }, (_, i) => ({ id: String(i) }))).length, 100)
})

test('sorting: running first oldest first, then completed latest first', () => {
  const sorted = m.sortSubagents([t({ id: 'c1', status: 'completed', endedAt: 10 }), t({ id: 'r2', startTime: 50 }), t({ id: 'c2', status: 'completed', endedAt: 20 }), t({ id: 'r1', startTime: 5 })])
  assert.deepEqual(sorted.map((x) => x.id), ['r1', 'r2', 'c2', 'c1'])
})

test('grouping skips empty terminals and counts running', () => {
  const groups = m.groupSubagents([{ id: 'w1', name: 'A', tasks: [] }, { id: 'w2', name: 'B', tasks: [t({ id: 'x' }), t({ id: 'y', status: 'completed' })] }])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].running, 1)
  assert.equal(m.countRunning([[t({})], [t({ status: 'completed' }), t({})]]), 2)
})

test('formatting: names, models, elapsed', () => {
  assert.equal(m.subagentName(t({ label: '', description: 'D' })), 'D')
  assert.equal(m.subagentName(t({ label: '', description: '', agentType: 'Plan' })), 'Plan')
  assert.equal(m.shortModel('claude-haiku-5-5'), 'haiku-5-5')
  assert.equal(m.shortModel('claude-haiku-4-5-20251001'), 'haiku-4-5')
  assert.equal(m.shortModel(null), '')
  assert.equal(m.subagentElapsed(t({ startTime: 0 }), 45_000), '45s')
  assert.equal(m.subagentElapsed(t({ startTime: 0 }), 192_000), '3m 12s')
  assert.equal(m.subagentElapsed(t({ startTime: 0 }), 3_900_000), '1h 05m')
  assert.equal(m.subagentElapsed(t({ startTime: 0, status: 'completed', endedAt: 61_000 }), 999_999), '1m 01s')
  assert.equal(m.subagentElapsed(t({ startTime: null }), 5), null)
})
