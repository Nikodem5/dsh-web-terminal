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

// ── 12. a terminal that was opened in another tab ──

test('reconnectWin takes a terminal back after another tab had it', async () => {
  const { id, rt, sock } = await open()
  sock.drop(4000)
  assert.equal(rt.conn, 'lost')
  assert.equal(rt.detail, s.OTHER_TAB)
  const count = FakeWebSocket.instances.length
  s.reconnectWin(id)
  assert.equal(FakeWebSocket.instances.length, count + 1, 'a new socket is opened at once')
  assert.equal(rt.conn, 'connecting')
  s.reconnectWin(id)
  assert.equal(FakeWebSocket.instances.length, count + 1, 'only a lost terminal reconnects')
})

// ── 14. the Rows preset and the minimum window height ──

test('Rows wraps into columns instead of making windows shorter than the minimum', () => {
  const ids = Array.from({ length: 7 }, () => s.openTerminal({ cwd: 'C:\work' }))
  s.arrange('rows') // height unknown: one column, as before
  assert.equal(new Set(s.getWins().map((w) => w.x)).size, 1)
  s.arrange('rows', 400) // room for 3 rows of 130px
  const wins = s.getWins()
  for (const w of wins) assert.ok(w.h * 400 >= s.MIN_ROW_PX, `window ${w.id} is ${w.h * 400}px tall`)
  assert.equal(new Set(wins.map((w) => w.x)).size, 3, 'seven windows wrap into three columns')
  for (let i = 0; i < wins.length; i++) for (let j = i + 1; j < wins.length; j++) {
    const a = wins[i], b = wins[j]
    assert.ok(a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9 || a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9, 'no overlap')
  }
  s.arrange('rows', 1000)
  assert.equal(new Set(s.getWins().map((w) => w.x)).size, 1, 'tall canvas: one column')
  assert.equal(ids.length, 7)
})

// ── 15. failures that used to be silent ──

test('a refused clipboard write or paste shows a notice', async () => {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')), readText: () => Promise.reject(new Error('denied')) }, configurable: true })
  const { rt, handler } = await open()
  rt.term.selectAll()
  handler(ev({ key: 'C', ctrlKey: true, shiftKey: true }))
  await until(() => s.getNotices().some((n) => /Copy failed/.test(n.text)), 'the copy notice')
  handler(ev({ key: 'V', ctrlKey: true, shiftKey: true }))
  await until(() => s.getNotices().some((n) => /Paste failed/.test(n.text)), 'the paste notice')
})

test('broadcastLine reports how many terminals got the line', async () => {
  const a = await open()
  const b = await open()
  s.setBroadcast({ on: true })
  assert.equal(s.broadcastLine('ls'), 2)
  b.sock.drop()
  assert.equal(s.broadcastLine('ls'), 1, 'a disconnected terminal does not count')
  assert.equal(a.sock.sent.filter((f) => f.data === 'ls\r').length, 2)
})

// ── 10. the block header decides from row counts ──

test('blockOutputBlocked reads no text from the buffer; blank output is found out when an action runs', async () => {
  const { rt } = await open()
  const blank = '\x1b]133;A\x07$ \x1b]133;B\x07true\r\n\x1b]633;E;true\x07\x1b]133;C\x07\r\n\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ \x1b]133;B\x07'
  rt.term.write(blank)
  await new Promise((resolve) => rt.term.write('', resolve))
  const block = rt.blocks.list().find((b) => b.command === 'true')
  assert.ok(block, 'the finished command has a block')
  const buf = rt.term.buffer.active
  const real = buf.getLine.bind(buf)
  let reads = 0
  buf.getLine = (y) => { reads++; return real(y) }
  try {
    assert.equal(s.blockOutputBlocked(rt, block), undefined, 'rows exist, so the actions are offered')
    assert.equal(reads, 0, 'no buffer line was read')
  } finally {
    delete buf.getLine
  }
  assert.ok('disabled' in s.blockOutput(rt, block), 'extracting finds that there is only blank output')
  assert.equal(await s.copyBlockOutput(rt, block), false)
})

// ── 8. unread bookkeeping while output streams in the background ──

test('background output redraws at most once per frame, and not at all once the badge is capped', async () => {
  const { id, rt } = await open()
  let emits = 0
  const stop = s.subscribe(() => emits++)
  try {
    const line = async (n) => {
      rt.term.write(`line ${n}\r\n`)
      await new Promise((resolve) => rt.term.write('', resolve))
    }
    const t0 = Date.now()
    for (let i = 0; i < 150; i++) await line(i)
    const frames = Math.ceil((Date.now() - t0) / 16) + 2
    assert.ok(s.unreadCount(id) > 99, 'the lines were counted')
    assert.ok(emits <= frames, `${emits} redraws for 150 writes in ${Date.now() - t0} ms (at most ${frames} frames)`)
    assert.ok(emits < 100, 'not one redraw per write')
    await sleep(120) // let a pending frame emit
    const settled = emits
    for (let i = 150; i < 250; i++) await line(i)
    await sleep(120)
    assert.equal(emits, settled, 'the badge reads 99+ either way: nothing to redraw')
  } finally {
    stop()
  }
})

test('focus changes still move the new-since marks: only the terminals concerned are re-decided', async () => {
  const a = await open()
  const b = await open()
  // Neither is focused or looked at: both keep counting.
  for (const t of [a, b]) {
    t.rt.term.write('x\r\ny\r\n')
    await new Promise((resolve) => t.rt.term.write('', resolve))
  }
  await sleep(80)
  assert.ok(s.unreadCount(a.id) > 0 && s.unreadCount(b.id) > 0)
  // Focus a while the page is focused: a is looked at, so it is not "unread"; b still is.
  const had = window.document.hasFocus
  window.document.hasFocus = () => true
  s.setViewMounted(true)
  try {
    s.focusWin(a.id)
    assert.equal(s.unreadCount(a.id), 0, 'the focused terminal is looked at')
    assert.ok(s.unreadCount(b.id) > 0, 'the other one still counts')
    s.focusWin(b.id)
    assert.equal(s.unreadCount(b.id), 0)
    a.rt.term.write('more\r\n')
    await new Promise((resolve) => a.rt.term.write('', resolve))
    await sleep(80)
    assert.ok(s.unreadCount(a.id) > 0, 'a, no longer focused, counts again')
  } finally {
    s.setViewMounted(false)
    window.document.hasFocus = had
  }
})

// ── 11. GPU contexts only for shown windows ──

test('a minimized window gives its GPU context back, and gets one again when shown', async () => {
  const made = []
  const real = s.gpuRenderer.create
  s.gpuRenderer.create = () => {
    const addon = { disposed: false, activate() {}, dispose() { this.disposed = true }, onContextLoss() {} }
    made.push(addon)
    return addon
  }
  try {
    const { id, rt } = await open() // openRuntime attached one
    assert.equal(made.length, 1)
    s.setRenderer(rt, false)
    assert.equal(made[0].disposed, true, 'minimized: the context is released')
    s.setRenderer(rt, false)
    assert.equal(made.length, 1, 'releasing twice does nothing')
    s.setRenderer(rt, true)
    assert.equal(made.length, 2, 'shown again: a new context')
    s.setRenderer(rt, true)
    assert.equal(made.length, 2, 'attaching twice does nothing')

    // A terminal whose window is minimized when it first opens never takes a context.
    const other = s.openTerminal({ cwd: 'C:\work' })
    s.updateWin(other, { minimized: true })
    const rt2 = s.ensureRuntime(s.getWins().find((w) => w.id === other))
    s.openRuntime(rt2)
    assert.equal(made.length, 2, 'no context for a minimized window')
    s.setRenderer(rt2, true)
    assert.equal(made.length, 3)
    assert.ok(id)
  } finally {
    s.gpuRenderer.create = real
  }
})
