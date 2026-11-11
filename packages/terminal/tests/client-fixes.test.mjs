// Regression tests for the client fixes (clipboard, input while offline, dialogs, layout limits, ...).
//
//   node --test tests/client-fixes.test.mjs

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

let s

before(async () => {
  s = await loadStore()
})
after(() => {
  s.clearNotices()
  s.closeAll()
  window.close()
})
afterEach(() => quiesceStores())
beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  s.clearNotices()
  window.localStorage.clear()
  FakeWebSocket.reset()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** An attached runtime and its xterm key handler. */
async function open() {
  const count = FakeWebSocket.instances.length
  const id = s.openTerminal({ cwd: 'C:\\work' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt)
  const sock = await until(() => FakeWebSocket.instances[count], 'a socket')
  sock.push({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null })
  rt.term.write('some output\r\n')
  await new Promise((resolve) => rt.term.write('', resolve))
  const handler = rt.term._core._customKeyEventHandler
  return { id, rt, sock, handler }
}

const ev = (init) => new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

/** Replace navigator.clipboard with a recorder. */
function clipboard() {
  const written = []
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => void written.push(t) }, configurable: true })
  return written
}

// ── 1. Ctrl+Shift+C ──

test('Ctrl+Shift+C with no selection leaves the clipboard alone; with one it copies', async () => {
  const written = clipboard()
  const { rt, handler } = await open()
  rt.term.clearSelection()
  assert.equal(handler(ev({ key: 'C', ctrlKey: true, shiftKey: true })), false, 'the chord is still claimed')
  assert.deepEqual(written, [], 'nothing is written for an empty selection')
  rt.term.selectAll()
  assert.equal(handler(ev({ key: 'C', ctrlKey: true, shiftKey: true })), false)
  assert.equal(written.length, 1)
  assert.ok(written[0].includes('some output'))
})

// ── 2. typing while reconnecting ──

test('typing while the socket is down shows a notice instead of dropping keys silently', async () => {
  const { rt, sock } = await open()
  rt.term.input('a', true)
  assert.deepEqual(s.getNotices(), [], 'a live terminal shows nothing')
  assert.ok(sock.sent.some((f) => f.type === 'input' && f.data === 'a'))
  sock.drop()
  assert.equal(rt.conn, 'lost')
  rt.term.input('b', true)
  assert.equal(s.getNotices().length, 1)
  assert.match(s.getNotices()[0].text, /not sent/)
  rt.term.input('c', true)
  assert.equal(s.getNotices().length, 1, 'the same notice is not stacked')
  assert.ok(!sock.sent.some((f) => f.data === 'b' || f.data === 'c'), 'the keys are not queued')
})

// ── 7. saved geometry ──

test('saved window rectangles are pulled into range on load', async () => {
  const fresh = await loadStore({ fresh: true })
  const base = { shell: 'default', cwd: '', pinned: false, maximized: false, minimized: false, z: 1 }
  window.localStorage.setItem(fresh.K_LAYOUT, JSON.stringify({ zTop: 3, wins: [
    { ...base, id: 'zero', x: 0.2, y: 0.2, w: 0, h: 0 },
    { ...base, id: 'far', x: 50, y: -9, w: 0.5, h: 0.5 },
    { ...base, id: 'huge', x: 0, y: 0, w: 40, h: 40, restore: { x: 9, y: 9, w: 0, h: 5 } },
    { ...base, id: 'fine', x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
  ] }))
  fresh.hydrate()
  const by = (id) => fresh.getWins().find((w) => w.id === id)
  for (const w of fresh.getWins()) {
    assert.ok(w.w >= 0.05 && w.w <= 1 && w.h >= 0.05 && w.h <= 1, `${w.id} has a visible size`)
    assert.ok(w.x < 1 && w.x + w.w > 0 && w.y >= 0 && w.y < 1, `${w.id} is on the canvas`)
  }
  assert.ok(by('zero').w > 0 && by('zero').h > 0)
  assert.ok(by('far').x < 1 && by('far').y === 0)
  assert.deepEqual([by('huge').w, by('huge').h], [1, 1])
  assert.ok(by('huge').restore.w > 0 && by('huge').restore.x < 1)
  assert.deepEqual({ x: by('fine').x, y: by('fine').y, w: by('fine').w, h: by('fine').h }, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, 'a sane rectangle is untouched')
})
