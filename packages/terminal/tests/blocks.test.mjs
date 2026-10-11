// Command blocks, client half: OSC parsing, the block model fed by a synthetic shell stream, the gutter
// decoration once a terminal is opened, and the prompt-ready signal.
//
//   npm test   (or: node --test tests/blocks.test.mjs)

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, window } from './helpers/load-store.mjs'

let s

before(async () => {
  s = await loadStore()
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
  s.prefs.shellIntegration = true
  Object.assign(s.startupTiming, { minMs: 40, settleMs: 120, maxMs: 700 })
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
const flush = (rt) => new Promise((resolve) => { s.flushOutput(rt); rt.term.write('', resolve) })
const attached = (extra = {}) => ({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null, ...extra })
const typed = (sock, text) => sock.sent.some((f) => f.type === 'input' && f.data === text)

const ESC = '\x1b'
const osc = (body) => `${ESC}]${body}\x07`

/** A runtime that is not opened (like one created at plugin start) and its socket. */
async function unopened(opts = {}) {
  const id = s.openTerminal({ cwd: 'C:\\work', startup: '', ...opts })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const sock = await until(() => FakeWebSocket.last, 'the first socket')
  return { id, rt, sock }
}

// ── parsing ──

test('parseSemantic: the 133 and 633 sequences', () => {
  assert.deepEqual(s.parseSemantic(133, 'A'), { kind: 'prompt-start' })
  assert.deepEqual(s.parseSemantic(133, 'A;aid=3'), { kind: 'prompt-start' })
  assert.deepEqual(s.parseSemantic(133, 'B'), { kind: 'prompt-end' })
  assert.deepEqual(s.parseSemantic(133, 'C'), { kind: 'output-start' })
  assert.deepEqual(s.parseSemantic(133, 'D;0'), { kind: 'finished', exitCode: 0 })
  assert.deepEqual(s.parseSemantic(133, 'D;130'), { kind: 'finished', exitCode: 130 })
  assert.deepEqual(s.parseSemantic(133, 'D'), { kind: 'finished', exitCode: undefined })
  assert.deepEqual(s.parseSemantic(133, 'D;nope'), { kind: 'finished', exitCode: undefined })
  assert.deepEqual(s.parseSemantic(633, 'C'), { kind: 'output-start' }, '633 repeats A-D')
  assert.equal(s.parseSemantic(133, 'Z'), undefined)
  assert.equal(s.parseSemantic(133, ''), undefined)
  assert.equal(s.parseSemantic(9, 'A'), undefined)
})

test('parseSemantic: command lines and the folder are unescaped; E and P belong to 633 only', () => {
  assert.deepEqual(s.parseSemantic(633, 'E;echo a\\x3bb\\\\c'), { kind: 'command', command: 'echo a;b\\c' })
  assert.deepEqual(s.parseSemantic(633, 'E;echo hi;nonce123'), { kind: 'command', command: 'echo hi' }, 'a trailing nonce is ignored')
  assert.deepEqual(s.parseSemantic(633, 'E;a\\x0ab'), { kind: 'command', command: 'a\nb' })
  assert.deepEqual(s.parseSemantic(633, 'P;Cwd=C:\\\\Users\\\\me'), { kind: 'cwd', cwd: 'C:\\Users\\me' })
  assert.deepEqual(s.parseSemantic(633, 'P;Cwd=/home/a b'), { kind: 'cwd', cwd: '/home/a b' })
  assert.equal(s.parseSemantic(633, 'P;Other=1'), undefined)
  assert.equal(s.parseSemantic(133, 'E;x'), undefined)
  assert.equal(s.parseSemantic(133, 'P;Cwd=/x'), undefined)
})

test('OSC 7 file URIs: Windows drive, POSIX path, percent-encoding, bad input', () => {
  assert.deepEqual(s.parseSemantic(7, 'file:///C:/Users/me/a%20b'), { kind: 'cwd', cwd: 'C:/Users/me/a b' })
  assert.deepEqual(s.parseSemantic(7, 'file://host/home/me'), { kind: 'cwd', cwd: '/home/me' })
  assert.equal(s.parseSemantic(7, 'http://x/y'), undefined)
  assert.equal(s.parseSemantic(7, 'file://host/%E0%A4%A'), undefined)
})

test('escapeValue and unescapeValue round-trip anything, and an escaped value never holds ; or a control character', () => {
  for (const text of ['plain', 'a;b', 'back\\slash', 'line1\nline2\ttab', 'esc\x1b[0m', 'mix;\\;\x07', 'unicode ✓ ą', '']) {
    const escaped = s.escapeValue(text)
    assert.doesNotMatch(escaped, /[;\x00-\x1f\x7f]/)
    assert.equal(s.unescapeValue(escaped), text)
  }
})

test('formatDuration', () => {
  assert.equal(s.formatDuration(40), '40ms')
  assert.equal(s.formatDuration(1234), '1.2s')
  assert.equal(s.formatDuration(15_000), '15s')
  assert.equal(s.formatDuration(184_000), '3m 04s')
  assert.equal(s.formatDuration(3_900_000), '1h 05m')
})

// ── the model, fed by a synthetic stream ──

test('a finished command becomes a block with its exit code, markers on the right lines and its command', async () => {
  const { rt, sock } = await unopened()
  sock.push(attached({ created: true }))
  sock.push({
    type: 'data',
    data: [
      osc('633;P;Cwd=C:\\\\work'), osc('133;A'), '$ ', osc('133;B'), 'ls\r\n',
      osc('633;E;ls'), osc('133;C'), 'out1\r\nout2\r\n',
      osc('133;D;1'),
    ].join(''),
  })
  await flush(rt)
  const [block, ...more] = rt.blocks.list()
  assert.equal(more.length, 0)
  assert.equal(rt.blocks.integrated, true)
  assert.equal(rt.cwd, 'C:\\work')
  assert.equal(block.state, 'done')
  assert.equal(block.exitCode, 1)
  assert.equal(block.command, 'ls')
  assert.equal(block.cwd, 'C:\\work')
  assert.equal(block.prompt.line, 0)
  assert.equal(block.input.line, 0)
  assert.equal(block.inputX, 2)
  assert.equal(block.outputStart.line, 1)
  assert.equal(block.end.line, 2, 'the cursor sits on the empty row after the last output line: the block ends one row up')
  assert.ok(block.endedAt >= block.startedAt)
  assert.equal(typeof s.blockDuration(block), 'number')
  assert.equal(rt.term.buffer.active.getLine(0).translateToString(true), '$ ls', 'the sequences print nothing')
})

test('several commands make several blocks; a running one has no exit code yet; an empty prompt leaves none', async () => {
  const { rt, sock } = await unopened()
  sock.push(attached({ created: true }))
  const prompt = (cmd) => `${osc('133;A')}$ ${osc('133;B')}${cmd}\r\n`
  sock.push({ type: 'data', data: prompt('one') + osc('133;C') + 'a\r\n' + osc('133;D;0') + prompt('') + prompt('two') + osc('133;C') + 'b\r\n' })
  await flush(rt)
  const blocks = rt.blocks.list()
  assert.deepEqual(blocks.map((b) => [b.command, b.state, b.exitCode]), [['one', 'done', 0], ['two', 'running', undefined]])
  assert.equal(blocks[1].prompt.line, 3, 'the empty prompt on row 2 did not become a block')
  assert.equal(s.blockDuration(blocks[1]) >= 0, true)
  // A new prompt with no D closes the running block with an unknown exit code.
  sock.push({ type: 'data', data: osc('133;A') + '$ ' + osc('133;B') })
  await flush(rt)
  const after = rt.blocks.list()
  assert.deepEqual(after.map((b) => [b.command, b.state, b.exitCode]), [['one', 'done', 0], ['two', 'done', undefined], ['', 'prompt', undefined]], 'the new prompt is the open block')
})

test('without the shell sending the command (bash sends it late, other shells never) it is read from the screen', async () => {
  const { rt, sock } = await unopened()
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: osc('133;A') + 'user@host:~$ ' + osc('133;B') + 'echo "a b"\r\n' + osc('133;C') + 'a b\r\n' })
  await flush(rt)
  assert.equal(rt.blocks.list()[0].command, 'echo "a b"')
  // The late E replaces the screen guess.
  sock.push({ type: 'data', data: osc('633;E;echo "a b"') + osc('133;D;0') })
  await flush(rt)
  assert.equal(rt.blocks.list()[0].commandFromShell, true)
})

test('a full-screen program keeps its block running until D', async () => {
  const { rt, sock } = await unopened()
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: osc('133;A') + '$ ' + osc('133;B') + 'vim\r\n' + osc('133;C') + `${ESC}[?1049h` + 'screen\r\n' })
  await flush(rt)
  assert.equal(rt.blocks.list()[0].state, 'running')
  sock.push({ type: 'data', data: `${ESC}[?1049l` + osc('133;D;0') })
  await flush(rt)
  const [b] = rt.blocks.list()
  assert.equal(b.state, 'done')
  assert.equal(b.exitCode, 0)
  assert.equal(b.outputStart.line, 1)
})

test('blocks are capped, and ones whose markers scrolled out are dropped', async () => {
  const { rt, sock } = await unopened({})
  sock.push(attached({ created: true }))
  const one = (i) => osc('133;A') + '$ ' + osc('133;B') + `c${i}\r\n` + osc('133;C') + 'x\r\n' + osc('133;D;0')
  let data = ''
  for (let i = 0; i < s.MAX_BLOCKS + 30; i++) data += one(i)
  sock.push({ type: 'data', data })
  await flush(rt)
  const blocks = rt.blocks.list()
  const kept = blocks.length
  assert.equal(kept, s.MAX_BLOCKS)
  assert.equal(blocks.at(-1).command, `c${s.MAX_BLOCKS + 29}`)
  assert.ok(blocks.every((b) => !b.prompt.isDisposed))
  // Past the scrollback (5000 rows) the oldest markers are disposed with their lines.
  sock.push({ type: 'data', data: 'filler\r\n'.repeat(6000) })
  await flush(rt)
  assert.ok(rt.blocks.list().length < kept)
})

test('a reattach replays the shell output and rebuilds the blocks', async () => {
  const { rt, sock } = await unopened()
  const replay = osc('133;A') + '$ ' + osc('133;B') + 'ls\r\n' + osc('133;C') + 'x\r\n' + osc('133;D;2')
  sock.push(attached({ created: false, replay }))
  await flush(rt)
  assert.deepEqual(rt.blocks.list().map((b) => [b.command, b.exitCode]), [['ls', 2]])
  // The next attach resets the screen: the old markers are gone with it.
  sock.push(attached({ created: false, replay: '' }))
  await flush(rt)
  assert.deepEqual(rt.blocks.list(), [])
})

// ── rendering ──

test('the gutter decoration is created once the terminal is opened, not before', async () => {
  const { rt, sock } = await unopened()
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: osc('133;A') + '$ ' + osc('133;B') + 'ls\r\n' + osc('133;C') + 'o\r\n' + osc('133;D;0') })
  await flush(rt)
  assert.equal(rt.opened, false)
  assert.equal(rt.blocks.list()[0].decoration, undefined, 'nothing to draw on yet')
  s.openRuntime(rt)
  const [b] = rt.blocks.list()
  assert.ok(b.decoration !== undefined && !b.decoration.isDisposed, 'drawn on open')
  assert.equal(b.decoration.marker, b.prompt)
  // A block that finishes after the open is drawn straight away.
  sock.push({ type: 'data', data: osc('133;A') + '$ ' + osc('133;B') + 'false\r\n' + osc('133;C') + osc('133;D;1') })
  await flush(rt)
  const last = rt.blocks.list()[1]
  assert.ok(last.decoration !== undefined)
})

// ── the prompt-ready signal ──

test('startupWait: a ready prompt means no waiting', () => {
  assert.equal(s.startupWait(1000, 1000, undefined, { minMs: 150, settleMs: 250, maxMs: 5000 }, true), 0)
  assert.equal(s.startupWait(1000, 1000, undefined, { minMs: 150, settleMs: 250, maxMs: 5000 }, false), 5000)
})

test('with shell integration the startup command is typed as soon as the first prompt is ready, not after the quiet period', async () => {
  Object.assign(s.startupTiming, { minMs: 3000, settleMs: 3000, maxMs: 6000 })
  const { sock } = await unopened({ startup: 'npm run dev' })
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: 'banner\r\n' + osc('133;A') + '$ ' })
  await sleep(150)
  assert.equal(typed(sock, 'npm run dev\r'), false, 'a prompt that is drawn but not ready for input is not enough')
  sock.push({ type: 'data', data: osc('133;B') })
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command right after B', 20000)
})

test('a shell without integration still waits for the quiet period', async () => {
  Object.assign(s.startupTiming, { minMs: 40, settleMs: 2500, maxMs: 8000 })
  const { sock } = await unopened({ startup: 'npm run dev' })
  sock.push(attached({ created: true }))
  sock.push({ type: 'data', data: 'PS C:\\> ' })
  await sleep(150)
  assert.equal(typed(sock, 'npm run dev\r'), false)
  await until(() => typed(sock, 'npm run dev\r'), 'the startup command after the quiet period', 20000)
})

// ── the preference ──

test('the preference rides on the socket URL: integration=0 only when it is off', async () => {
  await unopened()
  assert.doesNotMatch(FakeWebSocket.last.url, /integration=/)
  s.closeAll()
  FakeWebSocket.reset()
  s.setShellIntegration(false)
  assert.equal(s.getPrefs().shellIntegration, false)
  await unopened()
  assert.match(FakeWebSocket.last.url, /[?&]integration=0/)
})
