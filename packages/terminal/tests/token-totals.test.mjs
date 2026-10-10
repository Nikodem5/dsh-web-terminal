// All-time token totals: stats-cache base plus transcripts newer than the cache.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTokenTotals, endOfLocalDay } from '../lib/token-totals.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-wt-tokens-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0

const DEFAULT_MODELS = {
  a: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 5 },
  b: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
}

function writeCache(dir, date, modelUsage = DEFAULT_MODELS) {
  writeFileSync(join(dir, 'stats-cache.json'), JSON.stringify({ version: 5, lastComputedDate: date, modelUsage }))
}

/** A fresh fake Claude config dir with a stats-cache for `date`. */
function fixture(date = '2020-01-02', modelUsage) {
  const dir = join(root, `c${++n}`)
  mkdirSync(join(dir, 'projects', 'p1', 'subagents'), { recursive: true })
  writeCache(dir, date, modelUsage)
  return dir
}

const after1 = new Date(2020, 0, 3, 0, 30).toISOString() // 30 min after the cache day ended (local)
const before1 = new Date(2020, 0, 2, 23, 30).toISOString() // still inside the cache day
const entry = (id, [input, output, cacheRead, cacheCreation], timestamp = after1, extra = {}) =>
  `${JSON.stringify({ type: 'assistant', timestamp, ...extra, message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation } } })}\n`

test('endOfLocalDay is the next local midnight', () => {
  assert.equal(endOfLocalDay('2020-01-02'), new Date(2020, 0, 3).getTime())
  assert.equal(endOfLocalDay('2020-12-31'), new Date(2021, 0, 1).getTime())
  assert.equal(endOfLocalDay('nope'), undefined)
})

test('base from the cache, plus newer usage once per message, sub-agents included', async () => {
  const dir = fixture()
  const f = join(dir, 'projects', 'p1', 's.jsonl')
  writeFileSync(
    f,
    entry('m0', [9, 9, 9, 9], before1) + // inside the cache day: already counted by the cache
      entry('m1', [2, 5, 100, 10]) +
      entry('m1', [2, 40, 100, 10]) + // streamed repeat of m1 with its final output
      entry('m1', [2, 40, 100, 10]) +
      entry('m2', [1, 1, 1, 1], after1, { requestId: 'r' }) +
      '{"type":"user","message":{"usage":{}}}\n' +
      'not json "usage"\n' +
      `${JSON.stringify({ type: 'assistant', timestamp: after1, message: { id: 'nouse' } })}\n`,
  )
  // Sub-agent transcript; it also repeats m1 (resumed sessions copy history).
  writeFileSync(join(dir, 'projects', 'p1', 'subagents', 'agent-1.jsonl'), entry('m3', [4, 4, 4, 4]) + entry('m1', [2, 40, 100, 10]))
  const totals = createTokenTotals({ dir, now: () => 1234 })
  assert.equal(totals.get(), null, 'null before the first scan, never blocks')
  await totals.scan()
  assert.deepEqual(totals.get(), {
    total: 101 + 12 + 1003 + 9 + (2 + 40 + 100 + 10) + 4 + 16,
    input: 101 + 2 + 1 + 4,
    output: 12 + 40 + 1 + 4,
    cacheRead: 1003 + 100 + 1 + 4,
    cacheCreation: 9 + 10 + 1 + 4,
    asOf: 1234,
  })
})

test('only appended bytes are read, a half-written line waits, and truncation does not double count', async () => {
  const dir = fixture('2020-01-02', {})
  const f = join(dir, 'projects', 'p1', 's.jsonl')
  writeFileSync(f, entry('a', [1, 1, 1, 1]))
  const totals = createTokenTotals({ dir })
  await totals.scan()
  assert.equal(totals.get().total, 4)
  const half = entry('b', [10, 10, 10, 10])
  appendFileSync(f, half.slice(0, 20))
  await totals.scan()
  assert.equal(totals.get().total, 4, 'unfinished line not counted')
  appendFileSync(f, half.slice(20))
  await totals.scan()
  assert.equal(totals.get().total, 44)
  // Rewrite shorter: the file is read again from the start; message a is not counted twice.
  writeFileSync(f, entry('a', [1, 1, 1, 1]))
  truncateSync(f, Buffer.byteLength(entry('a', [1, 1, 1, 1])))
  await totals.scan()
  assert.equal(totals.get().total, 44)
  appendFileSync(f, entry('c', [100, 0, 0, 0]))
  await totals.scan()
  assert.equal(totals.get().total, 144)
})

test('files older than the cache day are skipped; a new cache date resets the delta', async () => {
  const dir = fixture('2020-01-02', {})
  const old = join(dir, 'projects', 'p1', 'old.jsonl')
  writeFileSync(old, entry('old', [1000, 0, 0, 0]))
  utimesSync(old, new Date(2019, 5, 1), new Date(2019, 5, 1))
  const cur = join(dir, 'projects', 'p1', 'cur.jsonl')
  writeFileSync(cur, entry('x', [5, 0, 0, 0]) + entry('y', [7, 0, 0, 0], new Date(2020, 0, 5, 1).toISOString()))
  const totals = createTokenTotals({ dir })
  await totals.scan()
  assert.equal(totals.get().total, 12)
  // Claude recomputed its cache through Jan 4: x is inside it now, y (Jan 5) is not.
  writeCache(dir, '2020-01-04', { m: { inputTokens: 50 } })
  await totals.scan()
  assert.equal(totals.get().total, 57)
})

test('a missing cache or projects dir yields zeros, never throws', async () => {
  const dir = join(root, 'empty')
  mkdirSync(dir)
  const totals = createTokenTotals({ dir })
  await totals.scan()
  assert.equal(totals.get().total, 0)
})

test('get() starts at most one scan per interval and returns the previous value meanwhile', async () => {
  const dir = fixture('2020-01-02', {})
  const f = join(dir, 'projects', 'p1', 's.jsonl')
  writeFileSync(f, entry('a', [1, 0, 0, 0]))
  let clock = 1_000_000
  const totals = createTokenTotals({ dir, intervalMs: 60_000, now: () => clock })
  assert.equal(totals.get(), null) // starts the first scan
  await totals.scan()
  assert.equal(totals.get().total, 1)
  appendFileSync(f, entry('b', [2, 0, 0, 0]))
  clock += 30_000
  assert.equal(totals.get().total, 1, 'not due yet')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(totals.get().total, 1)
  clock += 31_000
  assert.equal(totals.get().total, 1, 'due: scan starts, old value returned at once')
  for (let i = 0; i < 100 && totals.get().total !== 3; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(totals.get().total, 3)
})

test('restore shows a saved total until the first scan', () => {
  const saved = { total: 10, input: 1, output: 2, cacheRead: 3, cacheCreation: 4, asOf: 5 }
  const totals = createTokenTotals({ dir: join(root, 'nothing-here') })
  totals.restore({ total: 'x' })
  assert.equal(totals.serialize(), null)
  totals.restore(saved)
  assert.deepEqual(totals.serialize(), saved)
})
