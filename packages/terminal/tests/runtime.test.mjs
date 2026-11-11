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
  // Shrunk bounds so the quiet-period tests stay fast; the real ones are unit-tested below.
  Object.assign(s.startupTiming, { minMs: 40, settleMs: 120, maxMs: 700 })
  Object.assign(s.veilTiming, { timeoutMs: 5000, liftDelayMs: 30 })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until `check()` is truthy (the runtime connects on an animation frame, reconnects on a timer). */
async function until(check, what, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Resolves once xterm has parsed everything written so far. */
const flush = (rt) => new Promise((resolve) => { s.flushOutput(rt); rt.term.write('', resolve) })

const sub = (id, status = 'running') => ({ id, agentType: 'Explore', label: id, description: '', status, model: 'claude-haiku-5-5', startTime: 1000, endedAt: null, tokenCount: 5, contextWindowSize: null })

const signal = (state) => ({ provider: 'claude', state, detail: '' })
const attached = (extra = {}) => ({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null, ...extra })
const typed = (sock, text) => sock.sent.some((f) => f.type === 'input' && f.data === text)

/** Open a terminal and wait for its first socket. */
async function start(opts = {}) {
  const id = s.openTerminal({ cwd: 'C:\\work', startup: 'npm run dev', ...opts })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt) // the tests below drive xterm's textarea
  const sock = await until(() => FakeWebSocket.last, 'the first socket')
  return { id, rt, sock }
}

/** Drop the socket and wait for the runtime's reconnect. */
async function reconnect(sock) {
  sock.drop()
  return until(() => (FakeWebSocket.last !== sock ? FakeWebSocket.last : undefined), 'the reconnect', 20000)
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

test('startupWait: nothing until the shell prints, then min and quiet period, capped at the max', () => {
  const t = { minMs: 150, settleMs: 250, maxMs: 5000 }
  assert.equal(s.startupWait(1000, 1000, undefined, t), 5000, 'no output: wait for the max bound')
  assert.equal(s.startupWait(5900, 1000, undefined, t), 100)
  assert.equal(s.startupWait(6000, 1000, undefined, t), 0, 'max bound reached')
  assert.equal(s.startupWait(1010, 1000, 1005, t), 245, 'output just now: a full quiet period')
  assert.equal(s.startupWait(1100, 1000, 1000, t), 150, 'quiet period (250) counts from the output, not the attach')
  assert.equal(s.startupWait(1250, 1000, 1000, t), 0)
  assert.equal(s.startupWait(1100, 1000, 1050, t), 200, 'a later chunk restarts the quiet period')
  assert.equal(s.startupWait(1010, 1000, 800, t), 140, 'output before the attach still honours the minimum')
  assert.equal(s.startupWait(5990, 1000, 5980, t), 10, 'a chatty shell is cut off at the max bound')
  assert.equal(s.startupWait(7000, 1000, 6990, t), 0)
})

// ── attaching ──

test('the first attach of a new shell types the startup command', async () => {
  const { sock } = await start()
  sock.push(attached({ created: true }))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
})

test('a page reload (first attach, created: true) still types the startup command and shows the screen as live', async () => {
  const { rt, sock } = await start()
  sock.push(attached({ created: true }))
  assert.equal(rt.conn, 'live')
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
  assert.ok(!sock.sent.some((f) => f.type === 'kill'))
})

test('a shell with no startup command types nothing', async () => {
  const { sock } = await start({ startup: '' })
  sock.push(attached({ created: true }))
  await sleep(900)
  assert.ok(!sock.sent.some((f) => f.type === 'input'))
})

// ── prompt readiness ──

test('the startup command waits for the first output and then a quiet period', async () => {
  // Real timers: the quiet period is many times the sleeps below, so a loaded machine cannot cross it early.
  Object.assign(s.startupTiming, { minMs: 40, settleMs: 1500, maxMs: 8000 })
  const { sock } = await start()
  sock.push(attached({ created: true }))
  await sleep(300)
  assert.ok(!typed(sock, 'npm run dev\r'), 'a silent shell is not typed into before the max bound')
  const outAt = Date.now()
  sock.push({ type: 'data', data: 'PS C:\work> ' })
  await sleep(50)
  assert.ok(!typed(sock, 'npm run dev\r'), 'not while output is fresh')
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
  assert.ok(Date.now() - outAt >= 1400, 'after the quiet period')
})

test('output in many small chunks keeps pushing the startup command back', async () => {
  // Real timers: the quiet period is many times the sleeps below, so a loaded machine cannot cross it early.
  Object.assign(s.startupTiming, { minMs: 40, settleMs: 1500, maxMs: 8000 })
  const { sock } = await start()
  sock.push(attached({ created: true }))
  for (let i = 0; i < 6; i++) {
    sock.push({ type: 'data', data: `profile step ${i}\r\n` })
    await sleep(70)
    assert.ok(!typed(sock, 'npm run dev\r'), `still loading after chunk ${i}`)
  }
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
})

test('a shell that prints nothing gets the startup command at the max bound', async () => {
  // Real timers: the max bound is many times the sleep below, so a loaded machine cannot cross it early.
  Object.assign(s.startupTiming, { minMs: 40, settleMs: 120, maxMs: 2500 })
  const { sock } = await start()
  const t0 = Date.now()
  sock.push(attached({ created: true }))
  await sleep(200)
  assert.ok(!typed(sock, 'npm run dev\r'))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
  assert.ok(Date.now() - t0 >= 2400, 'not before the max bound')
})

test('the startup command is not typed if the socket closes while waiting', async () => {
  const { sock } = await start()
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: 'loading\r\n' })
  sock.drop()
  await sleep(900)
  assert.ok(!sock.sent.some((f) => f.type === 'input'))
})

test('the startup command is not typed if the terminal is closed while waiting', async () => {
  const { id, sock } = await start()
  sock.push(attached({ created: true }))
  s.disposeRuntime(id, false)
  await sleep(900)
  assert.ok(!sock.sent.some((f) => f.type === 'input'))
})

// ── the host restarts under an open page ──

test('a reconnect that finds a new shell keeps the screen, kills the stray shell, and offers Restart', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ created: true }))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
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
  await until(() => typed(fresh, 'npm run dev\r'), 'the startup command', 20000)
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
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
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

// ── host probe across a host restart ──

test('a host restart refreshes the probe, so the next Restart uses the new host settings file, not the dead one', async () => {
  const files = ['C:\\h\\claude-settings-1.json', 'C:\\h\\claude-settings-2.json']
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ providers: { claude: { launch: { settingsPath: files[Math.min(calls++, 1)] } } } }) })
  try {
    const { id, rt, sock } = await start({ startup: 'claude' })
    sock.push(attached({ created: true }))
    await until(() => sock.sent.some((f) => f.type === 'input' && f.data.includes('claude-settings-1.json')), 'the first command', 20000)
    assert.equal(calls, 1)

    const next = await reconnect(sock)
    next.push(attached({ created: true })) // the host restarted
    await flush(rt)
    await until(() => calls === 2, 'a second probe after the restart')

    s.restartWin(id)
    s.ensureRuntime(s.getWins().find((w) => w.id === id))
    const fresh = await until(() => (FakeWebSocket.last !== next ? FakeWebSocket.last : undefined), 'the new shell socket')
    fresh.push(attached({ created: true }))
    await until(() => fresh.sent.some((f) => f.type === 'input' && f.data.includes('claude-settings-2.json')), 'the command with the new settings file', 20000)
    assert.ok(!fresh.sent.some((f) => f.data?.includes('claude-settings-1.json')), 'the dead host file is never used')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a startup command typed after a probe that left a provider unprepared asks the host again', async () => {
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ providers: { claude: { launch: ++calls === 1 ? null : { settingsPath: 'C:\\h\\claude-settings-9.json' } } } }) })
  try {
    s.refreshHostInfo() // forget what earlier tests learned
    await s.hostInfoReady(1000) // settles with no settings file
    assert.equal(calls, 1)
    const { sock } = await start({ startup: 'claude' })
    sock.push(attached({ created: true }))
    await until(() => sock.sent.some((f) => f.type === 'input' && f.data.includes('claude-settings-9.json')), 'the command with the settings file', 20000)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── live broadcast mirror ──

test('isTerminalReport recognises what xterm answers to program queries, and nothing a user types', () => {
  for (const report of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[?62;4c', '\x1b[I', '\x1b[O', '\x1b[<35;10;10M', '\x1b[<0;11;10m', '\x1b[M !!', '\x1b[?2004;2$y', '\x1b[8;24;80t', '\x1b]11;rgb:0000/0000/0000\x07', '\x1bP1$r0m\x1b\\']) {
    assert.equal(s.isTerminalReport(report), true, JSON.stringify(report))
  }
  for (const typedText of ['a', 'ls -la\r', '\x1b', '\x1b[A', '\x1b[5~', '\x1bOP', '\x7f', '\x03', 'héllo wörld', '\x1b[200~pasted\x1b[201~', '[I', '12;40R']) {
    assert.equal(s.isTerminalReport(typedText), false, JSON.stringify(typedText))
  }
})

/** Two live terminals with live broadcast on. */
async function broadcastPair() {
  const a = await start()
  a.sock.push(attached())
  const idB = s.openTerminal({ cwd: 'C:\\other' })
  const rtB = s.ensureRuntime(s.getWins().find((w) => w.id === idB))
  s.openRuntime(rtB)
  const sockB = await until(() => FakeWebSocket.instances.find((x) => x.url.includes(idB)), 'the second socket')
  sockB.push(attached())
  s.setBroadcast({ on: true, live: true })
  s.setBroadcastTargets([a.id, idB])
  return { a, b: { id: idB, rt: rtB, sock: sockB } }
}
const inputs = (sock) => sock.sent.filter((f) => f.type === 'input').map((f) => f.data)

test('live broadcast mirrors typed keys and pasted text to the other terminals', async () => {
  const { a, b } = await broadcastPair()
  a.rt.term.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x', code: 'KeyX', keyCode: 88, bubbles: true }))
  a.rt.term.paste('pasted')
  assert.deepEqual(inputs(a.sock), ['x', 'pasted'], 'the terminal itself gets everything')
  assert.deepEqual(inputs(b.sock), ['x', 'pasted'])
  s.setBroadcast({ on: false, live: false })
})

test('live broadcast does not mirror xterm replies to program queries into the other shells', async () => {
  const { a, b } = await broadcastPair()
  // A program in terminal A asks for device attributes, cursor position and turns on focus + mouse reporting.
  a.rt.term.write('\x1b[c\x1b[6n\x1b[?1004h\x1b[?1000h\x1b[?1006h')
  await flush(a.rt)
  a.rt.term.input('\x1b[<35;10;10M')
  a.rt.term.input('\x1b[I')
  const own = inputs(a.sock)
  assert.ok(own.some((d) => /^\x1b\[\?[\d;]*c$/.test(d)), 'the reply still reaches the terminal that asked')
  assert.ok(own.some((d) => /^\x1b\[\d+;\d+R$/.test(d)), 'including the cursor position report')
  assert.deepEqual(inputs(b.sock), [], 'nothing the terminal said to its own program leaks to the other shell')
  s.setBroadcast({ on: false, live: false })
})

test('a key that looks like a report (Shift+F3 is CSI 1;2 R) is still mirrored', async () => {
  const { a, b } = await broadcastPair()
  a.rt.term.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F3', code: 'F3', keyCode: 114, shiftKey: true, bubbles: true }))
  assert.deepEqual(inputs(a.sock), ['\x1b[1;2R'])
  assert.deepEqual(inputs(b.sock), ['\x1b[1;2R'])
  s.setBroadcast({ on: false, live: false })
})

// ── attaching saved terminals at plugin start ──

const LAYOUT_KEY = 'dsh.web-terminal.layout.v1'
const savedWin = (id, extra = {}) => ({ id, title: id, shell: 'default', cwd: '/work/x', x: 0, y: 0, w: 0.5, h: 0.5, z: 1, pinned: false, maximized: false, minimized: false, ...extra })

/** A fresh store module whose saved layout is `wins`, started the way the plugin entry does. */
async function startSaved(wins) {
  const f = await s2()
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ wins, zTop: 2 }))
  f.startTerminals()
  return f
}
const s2 = async () => (await import('./helpers/load-store.mjs')).loadStore({ fresh: true })

test('startTerminals connects every saved window before any view exists, and only those', async () => {
  const f = await startSaved([savedWin('a'), savedWin('b', { startup: 'claude' })])
  await until(() => FakeWebSocket.instances.length === 2, 'both sockets')
  assert.deepEqual([...f.runtimes.keys()].sort(), ['a', 'b'])
  assert.ok(FakeWebSocket.instances.every((x) => x.url.includes('/terminal/ws?')))
  assert.ok([...f.runtimes.values()].every((rt) => !rt.opened), 'no DOM yet')
  f.startTerminals()
  await sleep(50)
  assert.equal(FakeWebSocket.instances.length, 2, 'a second start adds nothing')
  f.closeAll()
  await sleep(300)
})

test('startTerminals with nothing saved connects nothing', async () => {
  const f = await startSaved([])
  await sleep(100)
  assert.equal(FakeWebSocket.instances.length, 0)
  f.closeAll()
  await sleep(300)
})

test('an unopened terminal takes replay and agent signals: it raises attention with no page, and mounting reuses it', async () => {
  const f = await startSaved([savedWin('a', { startup: 'claude' })])
  const sock = await until(() => FakeWebSocket.last, 'the socket')
  const rt = f.runtimes.get('a')
  sock.push(attached({ created: false, replay: 'hello from before\r\n', agent: null }))
  sock.push({ type: 'agent', provider: 'claude', state: 'needs-you', detail: 'Permission needed' })
  assert.equal(rt.conn, 'live')
  assert.equal(rt.activity, 'needs-you')
  assert.equal(rt.attention, true)
  assert.ok(!sock.sent.some((x) => x.type === 'input'), 'a reattached session gets no startup command')
  await flush(rt)
  assert.equal(rt.term.buffer.active.getLine(0).translateToString(true), 'hello from before')

  // The page mounts: same runtime, same socket, buffered output now on screen.
  const body = window.document.createElement('div')
  window.document.body.appendChild(body)
  body.appendChild(rt.holder)
  f.refit(rt)
  assert.equal(f.ensureRuntime(f.getWins()[0]), rt)
  assert.equal(FakeWebSocket.instances.length, 1)
  assert.equal(rt.opened, true)
  assert.ok(rt.holder.querySelector('.xterm'))
  assert.equal(rt.term.buffer.active.getLine(0).translateToString(true), 'hello from before')
  body.remove()
  f.closeAll()
  await sleep(300)
})

test('a fresh session started before the page still types its startup command', async () => {
  const f = await startSaved([savedWin('a', { startup: 'npm run dev' })])
  const sock = await until(() => FakeWebSocket.last, 'the socket')
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: 'PS> ' })
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 20000)
  f.closeAll()
  await sleep(300)
})

test('subagents frames replace the list, the attached frame seeds it, a missing list means none', async () => {
  const { rt, sock } = await start()
  sock.push(attached({ subagents: [sub('a1')] }))
  await until(() => rt.subagents.length === 1, 'the attached list')
  const before = s.getVersion()
  sock.push({ type: 'subagents', tasks: [sub('a1', 'completed'), sub('a2'), { nope: true }, 'junk'] })
  await until(() => rt.subagents.length === 2, 'the frame list')
  assert.deepEqual(rt.subagents.map((t) => [t.id, t.status]), [['a1', 'completed'], ['a2', 'running']])
  assert.ok(s.getVersion() > before, 'a change emits')
  sock.push({ type: 'subagents', tasks: 'bad' })
  await until(() => rt.subagents.length === 0, 'an invalid list clears')
  assert.equal(s.runningSubagents(), 0)
  sock.push({ type: 'subagents', tasks: [sub('b1')] })
  await until(() => s.runningSubagents() === 1, 'running count')
  sock.push(attached())
  await until(() => rt.subagents.length === 0, 'an attach from an old host without the field')
})

test('an unopened terminal starts at its saved grid size and sends the same size to the host', async () => {
  const f = await startSaved([savedWin('a', { cols: 132, rows: 41 })])
  const sock = await until(() => FakeWebSocket.last, 'the socket')
  const rt = f.runtimes.get('a')
  assert.deepEqual([rt.term.cols, rt.term.rows], [132, 41])
  const q = new URL(sock.url).searchParams
  assert.deepEqual([q.get('cols'), q.get('rows')], ['132', '41'])
  f.closeAll()
  await sleep(300)
})

test('with no saved size, an unopened terminal uses an explicit default in both places; bad saved sizes are ignored', async () => {
  const f = await startSaved([savedWin('a'), savedWin('b', { cols: 'wide', rows: -3 })])
  await until(() => FakeWebSocket.instances.length === 2, 'both sockets')
  for (const sock of FakeWebSocket.instances) {
    const q = new URL(sock.url).searchParams
    assert.deepEqual([q.get('cols'), q.get('rows')], [String(f.UNOPENED_COLS), String(f.UNOPENED_ROWS)])
  }
  for (const rt of f.runtimes.values()) assert.deepEqual([rt.term.cols, rt.term.rows], [f.UNOPENED_COLS, f.UNOPENED_ROWS])
  f.closeAll()
  await sleep(300)
})

test('appearance options reach the Terminal and change live', async () => {
  const { rt } = await start()
  const o = rt.term.options
  assert.equal(o.fontSize, 14)
  assert.equal(o.lineHeight, 1.2)
  assert.equal(o.letterSpacing, 0)
  assert.equal(o.fontWeightBold, 600)
  assert.equal(o.minimumContrastRatio, 4.5)
  assert.ok(o.fontFamily.startsWith("'Cascadia Mono'"))
  s.setFont({ lineHeight: 1.5, letterSpacing: 1, boldWeight: 700, minContrast: 7, size: 16 })
  assert.deepEqual([o.lineHeight, o.letterSpacing, o.fontWeightBold, o.minimumContrastRatio], [1.5, 1, 700, 7])
  s.setFont({ ...s.DEFAULT_FONT })
  assert.deepEqual([o.lineHeight, o.letterSpacing, o.fontWeightBold, o.minimumContrastRatio], [1.2, 0, 600, 4.5])
})

test('the real grid is remembered on the window once the terminal reports it', async () => {
  const { id, rt } = await start()
  rt.term.resize(100, 30)
  rt.lastCols = 0
  s.sizeToHost(rt)
  const win = s.getWins().find((w) => w.id === id)
  assert.deepEqual([win.cols, win.rows], [100, 30])
})

// ── clickable file paths ──

/** Open a terminal and capture the link providers registered on it. */
async function startLinks() {
  const id = s.openTerminal({ cwd: '/work', startup: '' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const providers = []
  const register = rt.term.registerLinkProvider.bind(rt.term)
  rt.term.registerLinkProvider = (p) => (providers.push(p), register(p))
  s.openRuntime(rt)
  const provide = (y) => new Promise((resolve) => providers[providers.length - 1].provideLinks(y, resolve))
  return { id, rt, provide }
}

/** A fake host for /paths and /open; `existing` is the set of candidates that exist. */
function fakeHost(existing, openReply = { ok: true }) {
  const host = { pathCalls: [], opens: [], existing }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    if (String(url).endsWith('/paths')) {
      host.pathCalls.push(body)
      return { ok: true, json: async () => ({ ok: true, results: body.candidates.map((c) => ({ candidate: c, path: host.existing.has(c) ? `/work/${c}` : null, isDir: false })) }) }
    }
    if (String(url).endsWith('/open')) {
      host.opens.push(body)
      return { ok: true, json: async () => openReply }
    }
    return { ok: false }
  }
  host.restore = () => { globalThis.fetch = realFetch }
  return host
}

test('path links: an existing path is a link with the position stripped from the lookup, a missing one is not', async () => {
  const host = fakeHost(new Set(['src/a.ts']))
  try {
    const { rt, provide } = await startLinks()
    rt.term.write('see src/a.ts:12:5 and missing/b.ts\r\n')
    await flush(rt)
    const links = await provide(1)
    assert.equal(links.length, 1)
    assert.equal(links[0].text, 'src/a.ts:12:5')
    assert.deepEqual(links[0].range, { start: { x: 5, y: 1 }, end: { x: 17, y: 1 } })
    assert.deepEqual(host.pathCalls[0].candidates.sort(), ['missing/b.ts', 'src/a.ts'])
    assert.match(host.pathCalls[0].terminalId, /-0$/)
    assert.equal(host.pathCalls[0].cwd, '/work')
    // Same line again: answered from the cache (found and not-found alike).
    await provide(1)
    assert.equal(host.pathCalls.length, 1)
  } finally {
    host.restore()
  }
})

test('path links: activation needs the modifier; a plain click opens nothing', async () => {
  const host = fakeHost(new Set(['src/a.ts']))
  try {
    const { rt, provide } = await startLinks()
    rt.term.write('src/a.ts:12:5\r\n')
    await flush(rt)
    const [link] = await provide(1)
    link.activate({ ctrlKey: false, metaKey: false }, link.text)
    await sleep(20)
    assert.equal(host.opens.length, 0)
    link.activate({ ctrlKey: true, metaKey: false }, link.text)
    await until(() => host.opens.length === 1, 'the open request')
    assert.deepEqual(host.opens[0], { path: '/work/src/a.ts', line: 12, col: 5, target: 'vscode', template: '' })
  } finally {
    host.restore()
  }
})

test('path links: underline and pointer follow the modifier while hovering', async () => {
  const host = fakeHost(new Set(['a.ts']))
  try {
    const { rt, provide } = await startLinks()
    rt.term.write('a.ts\r\n')
    await flush(rt)
    const [link] = await provide(1)
    assert.deepEqual(link.decorations, { pointerCursor: false, underline: false })
    link.hover({ ctrlKey: false, metaKey: false, clientX: 0, clientY: 0 }, link.text)
    assert.equal(link.decorations.underline, false)
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    assert.deepEqual(link.decorations, { pointerCursor: true, underline: true })
    assert.match(rt.term.element.querySelector('.xterm-hover').textContent, /Ctrl\+click to open/)
    window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }))
    assert.equal(link.decorations.underline, false)
    link.leave({}, link.text)
    assert.equal(rt.term.element.querySelector('.xterm-hover'), null)
  } finally {
    host.restore()
  }
})

test('path links: a path wrapped over two rows is one link on either row', async () => {
  const host = fakeHost(new Set(['src/deep/file.ts']))
  try {
    const { rt, provide } = await startLinks()
    rt.term.resize(12, 5)
    rt.term.write('src/deep/file.ts\r\n')
    await flush(rt)
    const top = await provide(1)
    const bottom = await provide(2)
    assert.equal(top.length, 1)
    assert.equal(bottom.length, 1)
    assert.deepEqual(top[0].range, { start: { x: 1, y: 1 }, end: { x: 4, y: 2 } })
    assert.deepEqual(host.pathCalls[0].candidates, ['src/deep/file.ts'])
  } finally {
    host.restore()
  }
})

test('path links: a host error is shown inside the terminal', async () => {
  const host = fakeHost(new Set(['a.ts']), { ok: false, error: 'VS Code not found on PATH' })
  try {
    const { rt, provide } = await startLinks()
    rt.term.write('a.ts\r\n')
    await flush(rt)
    const [link] = await provide(1)
    link.activate({ ctrlKey: true, metaKey: false }, link.text)
    await until(() => rt.term.element.textContent.includes('VS Code not found on PATH'), 'the message')
  } finally {
    host.restore()
  }
})

test('path links: URLs and a failing host produce no links', async () => {
  const host = fakeHost(new Set())
  try {
    const { rt, provide } = await startLinks()
    rt.term.write('https://example.com/a/b.ts\r\n')
    await flush(rt)
    assert.equal(await provide(1), undefined)
    assert.equal(host.pathCalls.length, 0)
    globalThis.fetch = async () => { throw new Error('down') }
    rt.term.write('src/x.ts\r\n')
    await flush(rt)
    assert.equal(await provide(2), undefined)
  } finally {
    host.restore()
  }
})

// ── "new since you last looked" ──

test('newLinesSince / labels: counts from the blur-time cursor line, repaints add nothing', () => {
  assert.equal(s.newLinesSince(11, 10), 0, 'cursor line unchanged = nothing new')
  assert.equal(s.newLinesSince(11, 10 + 42), 42)
  assert.equal(s.newLinesSince(11, 4), 0, 'never negative')
  assert.equal(s.pillText(1), '↓ 1 new line')
  assert.equal(s.pillText(42), '↓ 42 new lines')
  const at = new Date(2026, 0, 5, 9, 7).getTime()
  assert.equal(s.timeLabel(at), '09:07')
  assert.equal(s.dividerText(at), '── new since 09:07 ──')
  const key = (init) => ({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'U', ...init })
  assert.equal(s.isUnreadJump(key()), true)
  assert.equal(s.isUnreadJump(key({ shiftKey: false })), false)
  assert.equal(s.isUnreadJump(key({ altKey: true })), false)
})

/** Two terminals, the page showing; `a` is looked at until `away()` focuses `b`. */
async function twoTerminals(opts = { startup: undefined }) {
  window.document.hasFocus = () => true
  s.setViewMounted(true)
  const a = await start(opts)
  a.sock.push(attached())
  const idB = s.openTerminal({ cwd: 'C:\other' })
  const rtB = s.ensureRuntime(s.getWins().find((w) => w.id === idB))
  s.openRuntime(rtB)
  s.focusWin(a.id)
  const lines = (n, tag = 'out') => Array.from({ length: n }, (_, i) => `${tag} ${i}\r\n`).join('')
  const out = async (text) => {
    a.sock.push({ type: 'data', data: text })
    await flush(a.rt)
  }
  const away = () => s.focusWin(idB)
  const back = () => s.focusWin(a.id)
  return { ...a, idB, out, away, back, lines, done: () => s.setViewMounted(false) }
}

test('unread: blur, output, focus draws the divider on the first new line', async () => {
  const t = await twoTerminals()
  try {
    await t.out('prompt$ ')
    const cursorAtBlur = t.rt.term.buffer.active.baseY + t.rt.term.buffer.active.cursorY
    t.away()
    assert.equal(s.unreadCount(t.id), 0)
    await t.out(t.lines(7))
    assert.equal(s.unreadCount(t.id), 7, 'the sidebar count follows the output')
    assert.equal(s.dividerLine(t.id), -1, 'no divider while nobody looks')
    t.back()
    assert.equal(s.dividerLine(t.id), cursorAtBlur + 1)
    assert.equal(s.unreadCount(t.id), 0, 'the sidebar indicator clears once looked at')
    // The divider stays through more output, and is replaced the next time the user leaves.
    await t.out(t.lines(2))
    assert.equal(s.dividerLine(t.id), cursorAtBlur + 1)
    t.away()
    assert.equal(s.dividerLine(t.id), -1, 'the old divider goes when the terminal is left again')
  } finally {
    t.done()
  }
})

test('unread: in-place repaints are not new output', async () => {
  const t = await twoTerminals()
  try {
    await t.out('status: working')
    t.away()
    await t.out('\r\x1b[2Kstatus: working.')
    await t.out('\r\x1b[2Kstatus: working..')
    assert.equal(s.unreadCount(t.id), 0)
    t.back()
    assert.equal(s.dividerLine(t.id), -1, 'nothing new, no divider')
  } finally {
    t.done()
  }
})

test('unread: output while on the alternate screen is skipped', async () => {
  const t = await twoTerminals()
  try {
    await t.out('$ vim\r\n\x1b[?1049h')
    t.away()
    await t.out(t.lines(30, 'vim'))
    assert.equal(s.unreadCount(t.id), 0)
    t.back()
    assert.equal(s.dividerLine(t.id), -1)
  } finally {
    t.done()
  }
})

test('unread: a marker that scrolled out of the scrollback leaves no divider', async () => {
  const t = await twoTerminals()
  try {
    await t.out('$ ')
    t.away()
    await t.out(t.lines(6000)) // scrollback is 5000 lines
    assert.equal(s.unreadCount(t.id), 0)
    t.back()
    assert.equal(s.dividerLine(t.id), -1)
    assert.equal(s.jumpToUnread(t.id), false)
  } finally {
    t.done()
  }
})

test('unread: the pill shows when the divider is above the viewport and jumping scrolls to it', async () => {
  const t = await twoTerminals()
  try {
    await t.out('$ ')
    t.away()
    await t.out(t.lines(80))
    t.back()
    const line = s.dividerLine(t.id)
    assert.ok(line > 0)
    assert.ok(t.rt.term.buffer.active.viewportY > line, 'the divider is above the visible rows')
    assert.equal(s.unreadPill(t.id), 80)
    // jsdom has no layout, so xterm's viewport cannot scroll here: check what the jump asks for.
    const asked = []
    t.rt.term.scrollToLine = (l) => asked.push(l)
    assert.equal(s.jumpToUnread(t.id), true)
    assert.deepEqual(asked, [line])
  } finally {
    t.done()
  }
})

/** What the views would show for the terminal right now: every surface of the feature. */
const unreadSurfaces = (t) => ({ count: s.unreadCount(t.id), pill: s.unreadPill(t.id), divider: s.dividerLine(t.id) })
const NOTHING = { count: 0, pill: 0, divider: -1 }

/** Away, 80 lines of output, back: the sequence that draws everything the feature has. */
async function awayAndBack(t) {
  await t.out('prompt> ')
  t.away()
  await t.out(t.lines(80))
  const whileAway = unreadSurfaces(t)
  t.back()
  return { whileAway, afterBack: unreadSurfaces(t) }
}

for (const opts of [{ startup: 'agy' }, { startup: 'agy -c' }, { startup: undefined, provider: 'antigravity' }]) {
  test('unread: a provider that repaints in place (Antigravity) gets no divider, count, pill or jump: ' + JSON.stringify(opts), async () => {
    const t = await twoTerminals(opts)
    try {
      // openTerminal derives the provider from the startup command; a saved window can carry one with none.
      if (opts.provider !== undefined) s.updateWin(t.id, { provider: opts.provider })
      assert.equal(s.providerOfWin(s.getWins().find((w) => w.id === t.id))?.id, 'antigravity', JSON.stringify(opts))
      const { whileAway, afterBack } = await awayAndBack(t)
      assert.deepEqual(afterBack, NOTHING, 'no divider or pill after coming back: ' + JSON.stringify(opts))
      assert.deepEqual(whileAway, NOTHING, 'no sidebar or Overview count while away: ' + JSON.stringify(opts))
      const asked = []
      t.rt.term.scrollToLine = (l) => asked.push(l)
      assert.equal(s.jumpToUnread(t.id), false, 'the jump is a no-op')
      assert.deepEqual(asked, [])
    } finally {
      t.done()
    }
  })
}

for (const opts of [{ startup: 'claude' }, { startup: 'npm run dev' }, { startup: undefined }]) {
  test('unread: Claude, plain command and plain shell windows keep the divider, count and pill: ' + JSON.stringify(opts), async () => {
    const t = await twoTerminals(opts)
    try {
      const { whileAway, afterBack } = await awayAndBack(t)
      assert.equal(whileAway.count, 80, JSON.stringify(opts))
      assert.ok(afterBack.divider > 0, 'divider drawn: ' + JSON.stringify(opts))
      assert.equal(afterBack.pill, 80, 'pill shown: ' + JSON.stringify(opts))
      assert.equal(s.jumpToUnread(t.id), true)
    } finally {
      t.done()
    }
  })
}

test('unread: no mark comes back through a buffer change or a rebase on a repainting provider', async () => {
  const t = await twoTerminals({ startup: 'agy' })
  try {
    await t.out('$ \r\n\x1b[?1049h') // a full-screen screen first (agy's sign-in)
    t.away()
    await t.out('\x1b[?1049l' + t.lines(5)) // back to the normal buffer while away: the onBufferChange path
    assert.deepEqual(unreadSurfaces(t), NOTHING)
    t.sock.push({ type: 'attached', created: false, replay: t.lines(20, 'old'), exited: false, exitCode: null, agent: null }) // the rebaseUnread path
    await flush(t.rt)
    await t.out(t.lines(5))
    assert.deepEqual(unreadSurfaces(t), NOTHING)
    t.back()
    assert.deepEqual(unreadSurfaces(t), NOTHING)
  } finally {
    t.done()
  }
})

test('unread: the capability is read from the window as it is now, not as it was when the runtime was built', async () => {
  const t = await twoTerminals({ startup: 'npm run dev' })
  try {
    await t.out('$ ')
    t.away()
    await t.out(t.lines(7))
    assert.equal(s.unreadCount(t.id), 7, 'a plain command counts')
    s.updateWin(t.id, { startup: 'agy', provider: 'antigravity' }) // reassigned: a restart with another command
    assert.deepEqual(unreadSurfaces(t), NOTHING, 'the marks already made are gone')
    await t.out(t.lines(3))
    assert.deepEqual(unreadSurfaces(t), NOTHING)
    t.back()
    assert.deepEqual(unreadSurfaces(t), NOTHING)
    // And back to a plain command: it counts again from the next time the user leaves.
    s.updateWin(t.id, { startup: 'npm run dev', provider: undefined })
    t.away()
    await t.out(t.lines(4))
    assert.equal(s.unreadCount(t.id), 4)
  } finally {
    t.done()
  }
})

test('unread: a runtime whose window is gone from the store does not throw', async () => {
  const t = await twoTerminals({ startup: 'agy' })
  try {
    await t.out('$ ')
    t.away()
    s.store.wins = s.store.wins.filter((w) => w.id !== t.id)
    await t.out(t.lines(3))
    assert.doesNotThrow(() => unreadSurfaces(t))
    assert.doesNotThrow(() => s.jumpToUnread(t.id))
    assert.doesNotThrow(() => s.rebaseUnread(t.rt))
  } finally {
    t.done()
  }
})

test('unread: the overview is not looking; it keeps unread state and a pick shows the divider', async () => {
  const t = await twoTerminals()
  try {
    await t.out('$ ')
    t.away()
    await t.out(t.lines(4))
    assert.equal(s.unreadCount(t.id), 4)
    s.enterOverview(t.idB)
    assert.equal(s.unreadCount(t.id), 4, 'entering the overview keeps the unread count')
    await t.out(t.lines(3))
    assert.equal(s.unreadCount(t.id), 7, 'still counting, and nothing is marked as seen')
    assert.equal(s.dividerLine(t.id), -1)
    const cursorAtMark = t.rt.term.buffer.active.baseY + t.rt.term.buffer.active.cursorY - 7
    s.exitOverview(t.id) // pick
    assert.equal(s.dividerLine(t.id), cursorAtMark + 1, 'the picked terminal shows its divider at the original spot')
    assert.equal(s.unreadCount(t.id), 0)
    // Leaving overview without a pick: the focused terminal is looked at again.
    s.enterOverview(t.id)
    await t.out(t.lines(2))
    s.exitOverview()
    assert.ok(s.dividerLine(t.id) > cursorAtMark + 1, 'a fresh divider marks where the overview started')
  } finally {
    s.exitOverview()
    t.done()
  }
})

// ── the veil over a starting agent terminal ──

const agy = { startup: 'agy' }
/** start() waits for the newest socket: forget the earlier terminals' sockets first when a test opens several. */
const startFresh = (opts) => { FakeWebSocket.reset(); return start(opts) }
const veilEl = (rt) => rt.holder.querySelector('.wt-veil')
const agySignal = (state) => ({ type: 'agent', provider: 'antigravity', state, detail: '' })

test('shouldVeil: a new shell with a provider startup command, never a plain, ssh or reattached one', () => {
  const claude = s.providerById('claude')
  const antigravity = s.providerById('antigravity')
  assert.equal(s.shouldVeil({ created: true, ssh: false, startup: 'claude', provider: claude }), true)
  assert.equal(s.shouldVeil({ created: true, ssh: false, startup: 'agy', provider: antigravity }), true)
  assert.equal(s.shouldVeil({ created: true, ssh: false, startup: 'npm run dev', provider: undefined }), false, 'plain command')
  assert.equal(s.shouldVeil({ created: true, ssh: false, startup: '', provider: claude }), false, 'nothing is typed')
  assert.equal(s.shouldVeil({ created: true, ssh: false, startup: undefined, provider: claude }), false)
  assert.equal(s.shouldVeil({ created: true, ssh: true, startup: 'claude', provider: claude }), false, 'ssh')
  assert.equal(s.shouldVeil({ created: false, ssh: false, startup: 'claude', provider: claude }), false, 'reattach')
})

test('veilText names the provider', () => {
  assert.equal(s.veilText('Antigravity'), 'Starting Antigravity…')
})

test('veil: a new Antigravity shell is veiled from attach, with a placeholder, and the terminal stays sized', async () => {
  const { rt, sock } = await startFresh(agy)
  sock.push(attached({ created: true }))
  assert.equal(rt.veiled, true)
  const el = veilEl(rt)
  assert.ok(el, 'a placeholder in the holder')
  assert.equal(el.textContent, 'Starting Antigravity…')
  assert.ok(rt.holder.querySelector('.xterm'), 'xterm stays attached, not display:none')
  rt.term.paste('x') // keystrokes still reach the terminal
  assert.ok(typed(sock, 'x'))
  s.disposeRuntime(rt.id, false)
})

test('veil: a new Claude shell is veiled with its own label', async () => {
  const { rt, sock } = await startFresh({ startup: 'claude' })
  sock.push(attached({ created: true }))
  assert.equal(rt.veiled, true)
  assert.equal(veilEl(rt).textContent, 'Starting Claude…')
  s.disposeRuntime(rt.id, false)
})

test('veil: not for a plain shell, an ssh window or a reattach to a live session', async () => {
  const plain = await startFresh()
  plain.sock.push(attached({ created: true }))
  assert.ok(!plain.rt.veiled)
  assert.equal(veilEl(plain.rt), null)

  const ssh = await startFresh({ startup: 'claude', ssh: { host: 'homepc' } })
  ssh.sock.push(attached({ created: true }))
  assert.ok(!ssh.rt.veiled)
  assert.equal(veilEl(ssh.rt), null)

  const live = await startFresh(agy)
  live.sock.push(attached({ created: false, replay: 'agy screen\r\n' }))
  assert.ok(!live.rt.veiled)
  assert.equal(veilEl(live.rt), null)
  await flush(live.rt)
  assert.equal(live.rt.term.buffer.active.getLine(0).translateToString(true), 'agy screen')
})

test('veil: the first agent signal of any state lifts it, after the repaint that follows an idle', async () => {
  for (const state of ['idle', 'needs-you', 'working', 'failed', 'ended']) {
    const { rt, sock } = await startFresh(agy)
    sock.push(attached({ created: true }))
    assert.equal(rt.veiled, true)
    sock.push(agySignal(state))
    // Not at once: the repaint that comes right after the signal has to land first.
    assert.equal(rt.veiled, true, `${state}: still up for the repaint`)
    await until(() => !rt.veiled, `${state} lifts the veil`)
    assert.equal(veilEl(rt), null)
    s.disposeRuntime(rt.id, false)
  }
})

test('veil: a repaint arriving after the signal is on screen before the veil lifts', async () => {
  const { rt, sock } = await startFresh(agy)
  sock.push(attached({ created: true }))
  sock.push(agySignal('idle'))
  sock.push({ type: 'data', data: '\x1b[Hagy logo' })
  await until(() => !rt.veiled, 'the veil to lift')
  assert.equal(rt.term.buffer.active.getLine(0).translateToString(true), 'agy logo', 'painted before it lifted')
  s.disposeRuntime(rt.id, false)
})

test('veil: restoreAgent (an agent state carried by the attach) lifts it too', async () => {
  const { rt } = await startFresh(agy)
  s.startVeil(rt, 'Antigravity')
  s.restoreAgent(rt, { provider: 'antigravity', state: 'idle', detail: '' })
  await until(() => !rt.veiled, 'the veil to lift')
  assert.equal(veilEl(rt), null)
  s.disposeRuntime(rt.id, false)
})

test('veil: lifts by itself after the timeout when no signal comes', async () => {
  Object.assign(s.veilTiming, { timeoutMs: 150 })
  const { rt, sock } = await startFresh({ startup: 'claude' })
  sock.push(attached({ created: true }))
  assert.equal(rt.veiled, true)
  await sleep(60)
  assert.equal(rt.veiled, true)
  await until(() => !rt.veiled, 'the timeout to lift the veil')
  assert.equal(veilEl(rt), null)
  s.disposeRuntime(rt.id, false)
})

test('veil: the shell exiting, a failed connection or a lost one lifts it at once', async () => {
  const a = await startFresh(agy)
  a.sock.push(attached({ created: true }))
  a.sock.push({ type: 'exit', exitCode: 1 })
  assert.equal(a.rt.veiled, false)
  assert.equal(veilEl(a.rt), null)

  const b = await startFresh(agy)
  b.sock.push(attached({ created: true }))
  b.sock.push({ type: 'error', message: 'cannot start' })
  assert.equal(b.rt.veiled, false)

  const c = await startFresh(agy)
  c.sock.push(attached({ created: true }))
  c.sock.drop()
  assert.equal(c.rt.veiled, false)
  s.closeAll()
})

test('veil: a reconnect that reattaches the same shell lifts it', async () => {
  const { rt, sock } = await startFresh(agy)
  sock.push(attached({ created: true }))
  assert.equal(rt.veiled, true)
  const next = await reconnect(sock)
  next.push(attached({ created: false, replay: 'agy screen\r\n' }))
  assert.equal(rt.veiled, false)
  assert.equal(veilEl(rt), null)
  s.disposeRuntime(rt.id, false)
})

test('veil: the timers are cleared when the runtime is dropped', async () => {
  Object.assign(s.veilTiming, { timeoutMs: 100 })
  const { rt, sock } = await startFresh(agy)
  sock.push(attached({ created: true }))
  sock.push(agySignal('idle')) // a lift is pending too
  s.disposeRuntime(rt.id, false)
  assert.equal(rt.veilTimeout, undefined)
  assert.equal(rt.veilLift, undefined)
  await sleep(250) // nothing fires on the disposed terminal
  assert.ok(!rt.veiled)
})

test('veil: the holder carries it between windows and a restart veils the new shell again', async () => {
  const { id, rt, sock } = await startFresh(agy)
  sock.push(attached({ created: true }))
  const a = window.document.createElement('div')
  const b = window.document.createElement('div')
  window.document.body.append(a, b)
  a.appendChild(rt.holder)
  b.appendChild(rt.holder) // moved to another window, or into the overview
  assert.ok(b.querySelector('.wt-veil'))
  assert.equal(rt.veiled, true)
  sock.push(agySignal('idle'))
  await until(() => !rt.veiled, 'the veil to lift')
  assert.equal(b.querySelector('.wt-veil'), null)

  s.restartWin(id)
  const fresh = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const next = await until(() => (FakeWebSocket.last !== sock ? FakeWebSocket.last : undefined), 'the new shell socket')
  next.push(attached({ created: true }))
  assert.equal(fresh.veiled, true, 'a restart is a new shell')
  assert.ok(veilEl(fresh))
  a.remove()
  b.remove()
  s.disposeRuntime(id, false)
})

// ── visibility ──

test('the host is told when the page is hidden and when it is shown again', async () => {
  const { sock } = await start()
  let state = 'hidden'
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => state })
  try {
    window.document.dispatchEvent(new window.Event('visibilitychange'))
    state = 'visible'
    window.document.dispatchEvent(new window.Event('visibilitychange'))
  } finally {
    delete window.document.visibilityState
  }
  assert.deepEqual(sock.sent.filter((f) => f.type === 'visibility'), [{ type: 'visibility', visible: false }, { type: 'visibility', visible: true }])
})
