// Runtime tests: how a terminal's browser half reacts to what the host does.
//
// A real xterm runtime runs under jsdom against a fake WebSocket that stands in for the
// host, so the frames the client sends and the screen it ends up with are both checked.
//
//   npm test   (or: node --test tests/runtime.test.mjs)

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, window } from './helpers/load-store.mjs'

let s // the loaded store module

before(async () => {
  s = await loadStore()
})

after(() => {
  // Let the process exit: stop the runtime ticker and jsdom's timers.
  s.closeAll()
  window.close()
})

beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  window.localStorage.clear()
  FakeWebSocket.reset()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until `check()` is truthy (the runtime connects on an animation frame, reconnects on a timer). */
async function until(check, what, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Resolves once xterm has parsed everything written so far. */
const flush = (rt) => new Promise((resolve) => rt.term.write('', resolve))

const signal = (state) => ({ provider: 'claude', state, detail: '' })
const attached = (extra = {}) => ({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null, ...extra })
const typed = (sock, text) => sock.sent.some((f) => f.type === 'input' && f.data === text)

/** Open a terminal and wait for its first socket. */
async function start(opts = {}) {
  const id = s.openTerminal({ cwd: 'C:\\work', startup: 'npm run dev', ...opts })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const sock = await until(() => FakeWebSocket.last, 'the first socket')
  return { id, rt, sock }
}

/** Drop the socket and wait for the runtime's reconnect. */
async function reconnect(sock) {
  sock.drop()
  return until(() => (FakeWebSocket.last !== sock ? FakeWebSocket.last : undefined), 'the reconnect', 5000)
}

// ── pure decisions ──

test('isHostRestart: only a new shell for a terminal that was attached before', () => {
  assert.equal(s.isHostRestart(true, true), true)
  assert.equal(s.isHostRestart(false, true), false, 'first attach after a page reload')
  assert.equal(s.isHostRestart(true, false), false, 'reattached to the same shell')
  assert.equal(s.isHostRestart(false, false), false)
})

test('hostRestartAlert: urgent when an agent was mid-task, quiet otherwise; always labelled', () => {
  for (const state of ['working', 'needs-you']) assert.equal(s.hostRestartAlert(state).level, 'urgent', state)
  for (const state of [undefined, 'idle', 'finished']) assert.equal(s.hostRestartAlert(state).level, 'quiet', String(state))
  assert.equal(s.hostRestartAlert('working').label, 'host restarted')
})

test('admitOutput: stays within the limit, exactly at it is fine', () => {
  assert.equal(s.admitOutput(0, 100, 100), true)
  assert.equal(s.admitOutput(1, 100, 100), false)
  assert.equal(s.admitOutput(0, s.MAX_PENDING_BYTES), true)
  assert.equal(s.admitOutput(0, s.MAX_PENDING_BYTES + 1), false)
})

// ── attaching ──

test('the first attach of a new shell types the startup command', async () => {
  const { sock } = await start()
  sock.push(attached({ created: true }))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 4000)
})

test('a page reload (first attach, created: true) still types the startup command and shows the screen as live', async () => {
  const { rt, sock } = await start()
  sock.push(attached({ created: true }))
  assert.equal(rt.conn, 'live')
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 4000)
  assert.ok(!sock.sent.some((f) => f.type === 'kill'))
})

test('a shell with no startup command types nothing', async () => {
  const { sock } = await start({ startup: '' })
  sock.push(attached({ created: true }))
  await sleep(900)
  assert.ok(!sock.sent.some((f) => f.type === 'input'))
})

// ── the host restarts under an open page ──

test('a reconnect that finds a new shell keeps the screen, kills the stray shell, and offers Restart', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ created: true }))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 4000)
  sock.push({ type: 'data', data: 'long running agent output\r\n' })
  s.applyAgentSignal(rt, signal('working'))
  await flush(rt)
  assert.match(s.bufferText(id), /long running agent output/)

  const next = await reconnect(sock)
  next.push(attached({ created: true }))
  await flush(rt)

  assert.match(s.bufferText(id), /long running agent output/, 'the old screen is not wiped')
  assert.match(s.bufferText(id), /host restarted/, 'a notice says what happened')
  assert.deepEqual(next.sent.filter((f) => f.type === 'kill'), [{ type: 'kill' }], 'the stray shell is killed')
  assert.equal(rt.conn, 'exited')
  assert.equal(rt.detail, 'host restarted')
  assert.equal(rt.activity, 'exited')
  assert.equal(rt.attention, true)
  assert.equal(rt.attentionLevel, 'urgent')
  assert.equal(rt.attentionLabel, 'host restarted')

  await sleep(900)
  assert.ok(!typed(next, 'npm run dev\r'), 'the startup command is not typed again')
  assert.ok(!next.sent.some((f) => f.type === 'input'), 'nothing is typed into the stray shell')
})

test('after a host restart, the stray shell dying or talking changes nothing', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ created: true }))
  await flush(rt)
  const next = await reconnect(sock)
  next.push(attached({ created: true }))
  next.push({ type: 'data', data: 'PROMPT-FROM-STRAY-SHELL' })
  next.push({ type: 'exit', exitCode: 0 })
  next.drop(1000)
  await flush(rt)
  assert.doesNotMatch(s.bufferText(id), /PROMPT-FROM-STRAY-SHELL/)
  assert.equal(rt.detail, 'host restarted')
  assert.equal(rt.conn, 'exited')
  await sleep(900)
  assert.equal(FakeWebSocket.last, next, 'no further reconnect is attempted')
})

test('restart after a host restart spawns a new shell that types the startup command', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ created: true }))
  await flush(rt)
  const next = await reconnect(sock)
  next.push(attached({ created: true }))
  s.restartWin(id)
  s.ensureRuntime(s.getWins().find((w) => w.id === id)) // the view does this when the window re-renders
  const fresh = await until(() => (FakeWebSocket.last !== next ? FakeWebSocket.last : undefined), 'the new shell socket')
  assert.ok(fresh.url.includes(`${id}-1`), 'a new generation id')
  fresh.push(attached({ created: true }))
  await until(() => typed(fresh, 'npm run dev\r'), 'the startup command', 4000)
  assert.ok(!fresh.sent.some((f) => f.type === 'kill'), 'the fresh shell is not mistaken for a host restart')
})

test('a reconnect to the same shell (created: false) replays the screen and stays live, as before', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: 'old screen\r\n' })
  await flush(rt)
  const next = await reconnect(sock)
  next.push(attached({ created: false, replay: 'replayed screen\r\n' }))
  await flush(rt)
  assert.equal(rt.conn, 'live')
  assert.match(s.bufferText(id), /replayed screen/)
  assert.doesNotMatch(s.bufferText(id), /old screen/, 'the screen is reset to the replay')
  await sleep(900)
  assert.ok(!next.sent.some((f) => f.type === 'kill' || f.type === 'input'))
})

// ── resync ──

test('resync repaints the screen from the replay without touching connection state or startup', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ created: true }))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 4000)
  sock.push({ type: 'data', data: 'garbled\r\n' })
  await flush(rt)
  const inputs = sock.sent.filter((f) => f.type === 'input').length

  sock.push({ type: 'resync', replay: 'true screen\r\n' })
  await flush(rt)
  assert.match(s.bufferText(id), /true screen/)
  assert.doesNotMatch(s.bufferText(id), /garbled/)
  assert.equal(rt.conn, 'live')
  await sleep(900)
  assert.equal(sock.sent.filter((f) => f.type === 'input').length, inputs, 'no startup command typed again')
  assert.ok(!sock.sent.some((f) => f.type === 'kill'))
})

test('a malformed resync is ignored', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached())
  sock.push({ type: 'data', data: 'keep me\r\n' })
  await flush(rt)
  for (const bad of [{ type: 'resync' }, { type: 'resync', replay: 5 }, { type: 'resync', replay: null }, 'not json{']) sock.push(bad)
  await flush(rt)
  assert.match(s.bufferText(id), /keep me/)
  assert.equal(rt.conn, 'live')
})

// ── flow control ──

test('output over the pending limit is dropped, and the terminal says so once it has caught up', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached())
  sock.push({ type: 'data', data: 'before\r\n' })
  await flush(rt)
  assert.equal(rt.pendingBytes, 0, 'a handled write leaves nothing pending')

  sock.push({ type: 'data', data: 'x'.repeat(s.MAX_PENDING_BYTES + 1) })
  assert.equal(rt.droppedOutput, true)
  assert.equal(rt.pendingBytes, 0, 'the flood was never queued')

  sock.push({ type: 'data', data: 'after\r\n' })
  await flush(rt)
  await until(() => !rt.droppedOutput, 'the drop notice')
  await flush(rt)
  const text = s.bufferText(id)
  assert.match(text, /before/)
  assert.match(text, /after/, 'output flows again afterwards')
  assert.match(text, /dropped/)
  assert.doesNotMatch(text, /xxxx/)
})

test('a malformed data frame is ignored', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached())
  sock.push({ type: 'data' })
  sock.push({ type: 'data', data: 42 })
  sock.push({ type: 'data', data: 'fine\r\n' })
  await flush(rt)
  assert.match(s.bufferText(id), /fine/)
  assert.equal(rt.pendingBytes, 0)
})
