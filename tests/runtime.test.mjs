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

// ── prompt readiness ──

test('the startup command waits for the first output and then a quiet period', async () => {
  const { sock } = await start()
  sock.push(attached({ created: true }))
  await sleep(300)
  assert.ok(!typed(sock, 'npm run dev\r'), 'a silent shell is not typed into before the max bound')
  const outAt = Date.now()
  sock.push({ type: 'data', data: 'PS C:\work> ' })
  await sleep(50)
  assert.ok(!typed(sock, 'npm run dev\r'), 'not while output is fresh')
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 1500)
  assert.ok(Date.now() - outAt >= 110, 'after the quiet period')
})

test('output in many small chunks keeps pushing the startup command back', async () => {
  const { sock } = await start()
  sock.push(attached({ created: true }))
  for (let i = 0; i < 6; i++) {
    sock.push({ type: 'data', data: `profile step ${i}\r\n` })
    await sleep(70)
    assert.ok(!typed(sock, 'npm run dev\r'), `still loading after chunk ${i}`)
  }
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 1500)
})

test('a shell that prints nothing gets the startup command at the max bound', async () => {
  const { sock } = await start()
  const t0 = Date.now()
  sock.push(attached({ created: true }))
  await sleep(500)
  assert.ok(!typed(sock, 'npm run dev\r'))
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 1500)
  assert.ok(Date.now() - t0 >= 650, 'not before the max bound')
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

// ── host probe across a host restart ──

test('a host restart refreshes the probe, so the next Restart uses the new host settings file, not the dead one', async () => {
  const files = ['C:\\h\\claude-settings-1.json', 'C:\\h\\claude-settings-2.json']
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ agent: { claudeSettings: files[Math.min(calls++, 1)] } }) })
  try {
    const { id, rt, sock } = await start({ startup: 'claude' })
    sock.push(attached({ created: true }))
    await until(() => sock.sent.some((f) => f.type === 'input' && f.data.includes('claude-settings-1.json')), 'the first command', 4000)
    assert.equal(calls, 1)

    const next = await reconnect(sock)
    next.push(attached({ created: true })) // the host restarted
    await flush(rt)
    await until(() => calls === 2, 'a second probe after the restart')

    s.restartWin(id)
    s.ensureRuntime(s.getWins().find((w) => w.id === id))
    const fresh = await until(() => (FakeWebSocket.last !== next ? FakeWebSocket.last : undefined), 'the new shell socket')
    fresh.push(attached({ created: true }))
    await until(() => fresh.sent.some((f) => f.type === 'input' && f.data.includes('claude-settings-2.json')), 'the command with the new settings file', 4000)
    assert.ok(!fresh.sent.some((f) => f.data?.includes('claude-settings-1.json')), 'the dead host file is never used')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a startup command typed after a probe that named no settings file asks the host again', async () => {
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ agent: { claudeSettings: ++calls === 1 ? null : 'C:\\h\\claude-settings-9.json' } }) })
  try {
    s.refreshHostInfo() // forget what earlier tests learned
    await s.hostInfoReady(1000) // settles with no settings file
    assert.equal(calls, 1)
    const { sock } = await start({ startup: 'claude' })
    sock.push(attached({ created: true }))
    await until(() => sock.sent.some((f) => f.type === 'input' && f.data.includes('claude-settings-9.json')), 'the command with the settings file', 4000)
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
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command', 4000)
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
