// The per-provider usage store: routing, stats, persistence and the version 1 file.
//
//   node --test tests/usage-store.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsageStore } from '../lib/usage-store.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-usage-store-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const freshDir = () => mkdtempSync(join(root, `d${++n}`))

/** A provider whose usage source records what it is given. */
function counter(id) {
  const state = { total: 0, removed: [], restored: undefined, change: undefined }
  return {
    state,
    provider: {
      id,
      usage: () => ({
        ingest: (_terminal, body) => { state.total += body.n; return true },
        removeSession: (terminal) => state.removed.push(terminal),
        stats: () => ({ total: state.total }),
        serialize: () => ({ total: state.total }),
        restore: (saved) => { state.restored = saved; if (typeof saved?.total === 'number') state.total = saved.total },
        onChange: (fn) => { state.change = fn },
      }),
    },
  }
}

test('payloads reach only their provider; stats list every source', () => {
  const a = counter('a')
  const b = counter('b')
  const store = createUsageStore({ providers: [a.provider, b.provider, { id: 'none' }], dir: freshDir() })
  store.ingest('a', 't1', { n: 2 })
  store.ingest('b', 't1', { n: 5 })
  store.ingest('none', 't1', { n: 9 })
  store.ingest('missing', 't1', { n: 9 })
  assert.deepEqual(store.stats(), { a: { total: 2 }, b: { total: 5 } })
  store.removeSession('t1')
  assert.deepEqual(a.state.removed, ['t1'])
  assert.deepEqual(b.state.removed, ['t1'])
})

test('a throwing source is contained', () => {
  const broken = { id: 'x', usage: () => ({ ingest() { throw new Error('a') }, stats() { throw new Error('b') }, serialize() { throw new Error('c') }, restore() { throw new Error('d') } }) }
  const failing = { id: 'y', usage: () => { throw new Error('no') } }
  const store = createUsageStore({ providers: [broken, failing], dir: freshDir() })
  store.ingest('x', 't', {})
  assert.deepEqual(store.stats(), { x: null })
  store.save(true)
})

test('saves version 2 only when something changed, throttled unless forced, and loads it back', () => {
  const dir = freshDir()
  let clock = 0
  const a = counter('a')
  const store = createUsageStore({ providers: [a.provider], dir, saveMs: 1000, now: () => clock })
  store.save(true)
  assert.throws(() => readFileSync(join(dir, 'usage.json')), 'nothing to save yet')
  store.ingest('a', 't', { n: 3 })
  clock = 2000
  store.save()
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')), { version: 2, providers: { a: { total: 3 } } })
  store.ingest('a', 't', { n: 1 })
  clock = 2500
  store.save()
  assert.equal(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).providers.a.total, 3, 'throttled')
  store.save(true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).providers.a.total, 4)
  // A background change marks the store dirty too.
  a.state.change()
  store.save(true)

  const again = counter('a')
  createUsageStore({ providers: [again.provider], dir })
  assert.deepEqual(again.state.restored, { total: 4 })
})

test('a version 1 file is read as Claude\'s', () => {
  const dir = freshDir()
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ version: 1, usage: { u: 1 }, tokens: { t: 2 } }))
  const claude = counter('claude')
  const other = counter('other')
  createUsageStore({ providers: [claude.provider, other.provider], dir })
  assert.deepEqual(claude.state.restored, { usage: { u: 1 }, tokens: { t: 2 } })
  assert.equal(other.state.restored, undefined)
})
