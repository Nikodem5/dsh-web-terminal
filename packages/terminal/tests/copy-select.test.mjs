// Copy on select (src/client/copy-select.ts): off by default, copies a settled selection, says so, and copes with a denied clipboard.
//
//   node --test tests/copy-select.test.mjs

import { test, before, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

let s
let written
let behaviour // 'allow' | 'deny' | 'missing'

before(async () => {
  s = await loadStore()
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    get: () => (behaviour === 'missing' ? undefined : { writeText: (text) => (behaviour === 'deny' ? Promise.reject(new Error('NotAllowedError')) : (written.push(text), Promise.resolve())) }),
  })
})
after(() => {
  s.closeAll()
  window.close()
})
beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  window.localStorage.clear()
  FakeWebSocket.reset()
  written = []
  behaviour = 'allow'
  s.setCopyOnSelect(false)
  quiesceStores()
})
afterEach(() => {
  mock.timers.reset()
  quiesceStores()
})

/** Let the promise chain of a clipboard write finish (timers are mocked, so this does not wait on a clock). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function open() {
  const id = s.openTerminal({ cwd: 'C:\\work' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt)
  await new Promise((resolve) => rt.term.write('hello world\r\nsecond line\r\n   \r\n', resolve))
  return rt
}
const toast = (rt) => rt.holder.querySelector('.wt-toast')

test('off by default: selecting does not touch the clipboard', async () => {
  assert.equal(s.getPrefs().term.copyOnSelect, false)
  const rt = await open()
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 0, 5)
  mock.timers.tick(s.COPY_SETTLE_MS * 4)
  await flush()
  assert.deepEqual(written, [])
  assert.equal(toast(rt), null)
})

test('on: the selection is copied once it settles, and a short note says so', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 0, 5)
  assert.deepEqual(written, [], 'not before the selection has settled')
  mock.timers.tick(s.COPY_SETTLE_MS)
  await flush()
  assert.deepEqual(written, ['hello'])
  assert.equal(toast(rt)?.textContent, 'Copied')
  assert.equal(toast(rt)?.dataset.kind, 'ok')
  mock.timers.tick(s.TOAST_MS)
  assert.equal(toast(rt), null, 'the note goes away by itself')
})

test('dragging a selection copies once, with the final text', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  mock.timers.enable({ apis: ['setTimeout'] })
  for (const len of [1, 2, 3, 4, 5, 8]) {
    rt.term.select(0, 0, len)
    mock.timers.tick(s.COPY_SETTLE_MS - 1)
  }
  mock.timers.tick(s.COPY_SETTLE_MS)
  await flush()
  assert.deepEqual(written, ['hello wo'])
})

test('the same selection is not copied twice; a different one after a clear is', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 0, 5)
  mock.timers.tick(s.COPY_SETTLE_MS)
  await flush()
  rt.term.select(0, 0, 5) // same text again, e.g. the selection was re-applied
  mock.timers.tick(s.COPY_SETTLE_MS)
  await flush()
  assert.deepEqual(written, ['hello'])
  rt.term.clearSelection()
  rt.term.select(6, 0, 5)
  mock.timers.tick(s.COPY_SETTLE_MS)
  await flush()
  assert.deepEqual(written, ['hello', 'world'], 'a new selection is copied')
})

test('a blank selection is not copied', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 2, 3) // the line of spaces
  mock.timers.tick(s.COPY_SETTLE_MS * 2)
  await flush()
  assert.deepEqual(written, [])
  assert.equal(toast(rt), null)
})

test('switching it off while a copy is pending cancels the copy', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 0, 5)
  s.setCopyOnSelect(false)
  mock.timers.tick(s.COPY_SETTLE_MS * 2)
  await flush()
  assert.deepEqual(written, [])
})

test('a denied clipboard shows "Copy blocked" and never throws', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  behaviour = 'deny'
  mock.timers.enable({ apis: ['setTimeout'] })
  const failures = []
  const onRejection = (reason) => failures.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    rt.term.select(0, 0, 5)
    mock.timers.tick(s.COPY_SETTLE_MS)
    await flush()
    assert.match(toast(rt)?.textContent ?? '', /Copy blocked/)
    assert.equal(toast(rt)?.dataset.kind, 'fail')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(failures, [])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('no clipboard API at all (an insecure page) is the same: a note, no crash', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  behaviour = 'missing'
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 0, 5)
  mock.timers.tick(s.COPY_SETTLE_MS)
  await flush()
  assert.match(toast(rt)?.textContent ?? '', /Copy blocked/)
})

test('a second note replaces the first instead of stacking', async () => {
  const rt = await open()
  s.showToast(rt, 'one', 'ok')
  s.showToast(rt, 'two', 'ok')
  assert.equal(rt.holder.querySelectorAll('.wt-toast').length, 1)
  assert.equal(toast(rt).textContent, 'two')
})

test('a terminal closed while a copy is pending copies nothing', async () => {
  const rt = await open()
  s.setCopyOnSelect(true)
  mock.timers.enable({ apis: ['setTimeout'] })
  rt.term.select(0, 0, 5)
  s.closeWin(rt.id)
  mock.timers.tick(s.COPY_SETTLE_MS * 2)
  await flush()
  assert.deepEqual(written, [])
})
