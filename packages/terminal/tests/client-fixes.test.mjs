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
  s.closeAll()
  window.close()
})
afterEach(() => quiesceStores())
beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  s.clearNotices?.()
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
