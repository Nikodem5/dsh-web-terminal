// Command blocks, phase 2: output extraction, rerun gating, navigation, the hover header and sticky bar
// on a real (jsdom) terminal fed a synthetic shell stream, and the long-command alerts.
//
//   node --test tests/blocks-actions.test.mjs

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
  s.closeSendMenu()
  s.prefs.commandNotifySec = 10
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
const ESC = '\x1b'
const osc = (body) => `${ESC}]${body}\x07`
const prompt = (cmd) => `${osc('133;A')}$ ${osc('133;B')}${cmd}\r\n${osc('633;E;' + cmd)}${osc('133;C')}`
const done = (code) => osc(`133;D;${code}`)
const row = (text, wrapped = false) => ({ wrapped, text: (trim) => (trim ? text.replace(/ +$/, '') : text) })
const rowsOf = (list) => (y) => list[y]

// ── pure parts ──

test('extractOutput joins wrapped rows, trims line ends and trailing blank lines', () => {
  const rows = [row('one   '), row('aaaa  '), row('bbb', true), row('three'), row('   '), row('')]
  const out = s.extractOutput(rowsOf(rows), 0, 5)
  // The first row of a wrapped line keeps its trailing blanks (they are part of the line); the last is trimmed.
  assert.equal(out.text, 'one\naaaa  bbb\nthree')
  assert.equal(out.last, 3)
  assert.equal(out.lastLen, 5)
  assert.equal(s.extractOutput(rowsOf([row(''), row('  ')]), 0, 1), undefined, 'only blanks: nothing')
  assert.equal(s.extractOutput(rowsOf([row('x'), row('y')]), 0, 0).text, 'x', 'stops at the last row asked for')
  // Leading blank lines are output too.
  assert.equal(s.extractOutput(rowsOf([row(''), row('x')]), 0, 1).text, '\nx')
})

test('outputRows: a block whose output scrolled out, never started or printed nothing is disabled', () => {
  const m = (line, isDisposed = false) => ({ line, isDisposed })
  assert.deepEqual(s.outputRows({ state: 'done', outputStart: m(3), end: m(7) }, 20, 0), { first: 3, last: 7 })
  assert.match(s.outputRows({ state: 'done', outputStart: m(3, true), end: m(7) }, 20, 0).disabled, /scrolled out/)
  assert.match(s.outputRows({ state: 'done', outputStart: m(3), end: m(7, true) }, 20, 0).disabled, /scrolled out/)
  assert.match(s.outputRows({ state: 'prompt', outputStart: undefined, end: undefined }, 20, 0).disabled, /no command output/)
  assert.match(s.outputRows({ state: 'done', outputStart: m(3), end: m(2) }, 20, 0).disabled, /no output/)
  // A running command is copied as it is now: up to the cursor row, or the one above it at column 0.
  assert.deepEqual(s.outputRows({ state: 'running', outputStart: m(3), end: undefined }, 9, 4), { first: 3, last: 9 })
  assert.deepEqual(s.outputRows({ state: 'running', outputStart: m(3), end: undefined }, 9, 0), { first: 3, last: 8 })
})

test('rerunGate: only a one-line command, at a prompt, in a live terminal', () => {
  const ok = { block: { command: 'npm test', id: 1 }, newest: { state: 'prompt', id: 2 }, live: true, hostBusy: false, alternate: false }
  assert.deepEqual(s.rerunGate(ok), { ok: true })
  assert.deepEqual(s.rerunGate({ ...ok, newest: { state: 'done', id: 1 } }), { ok: true }, 'the shell is between the end and the next prompt')
  assert.equal(s.rerunGate({ ...ok, newest: { state: 'running', id: 2 } }).ok, false)
  assert.equal(s.rerunGate({ ...ok, hostBusy: true }).ok, false)
  assert.equal(s.rerunGate({ ...ok, alternate: true }).ok, false)
  assert.equal(s.rerunGate({ ...ok, live: false }).ok, false)
  assert.equal(s.rerunGate({ ...ok, newest: undefined }).ok, false)
  assert.equal(s.rerunGate({ ...ok, block: { command: '', id: 1 } }).ok, false)
  assert.match(s.rerunGate({ ...ok, block: { command: 'a\nb', id: 1 } }).reason, /multi-line/)
  assert.match(s.rerunGate({ ...ok, newest: { state: 'running', id: 2 } }).reason, /running/)
})

test('stepTarget, failedTarget, stickyFor and blockAt work on prompt rows', () => {
  const spans = [
    { id: 1, prompt: 0, last: 9, failed: false },
    { id: 2, prompt: 10, last: 19, failed: true },
    { id: 3, prompt: 20, last: 29, failed: false },
    { id: 4, prompt: 30, last: 39, failed: true },
  ]
  assert.equal(s.stepTarget(spans, 25, -1), 20, 'previous from inside a block: its own prompt')
  assert.equal(s.stepTarget(spans, 20, -1), 10, 'previous from a prompt row: the one before')
  assert.equal(s.stepTarget(spans, 0, -1), undefined)
  assert.equal(s.stepTarget(spans, 20, 1), 30)
  assert.equal(s.stepTarget(spans, 30, 1), undefined)
  assert.equal(s.failedTarget(spans, 5, undefined), 30, 'first press: the newest failure')
  assert.equal(s.failedTarget(spans, 30, { prompt: 30, top: 30 }), 10, 'again: the one before')
  assert.equal(s.failedTarget(spans, 10, { prompt: 10, top: 10 }), 30, 'then it wraps')
  assert.equal(s.failedTarget(spans, 22, { prompt: 30, top: 30 }), 30, 'scrolled away since: start over')
  assert.equal(s.failedTarget(spans.filter((x) => !x.failed), 0, undefined), undefined)
  assert.equal(s.stickyFor(spans, 5)?.id, 1)
  assert.equal(s.stickyFor(spans, 0), undefined, 'the prompt itself is at the top: nothing to pin')
  assert.equal(s.stickyFor(spans, 10), undefined)
  assert.equal(s.blockAt(spans, 15)?.id, 2)
  assert.equal(s.blockAt(spans, 40), undefined)
})

test('isAgentCommand and commandAlert: thresholds, agent and full-screen skips, unattended, unknown exit', () => {
  for (const c of ['claude', '  claude --resume x', 'claude.exe', 'C:\\bin\\claude.cmd -p hi', '/usr/bin/claude']) assert.equal(s.isAgentCommand(c), true, c)
  for (const c of ['claudette', 'echo claude', 'npm test', '']) assert.equal(s.isAgentCommand(c), false, c)
  const base = { command: 'npm test', exitCode: 1, durationMs: 123_000, thresholdSec: 10, agent: false, fullScreen: false, unattended: true }
  const failed = s.commandAlert(base)
  assert.deepEqual(failed, { level: 'quiet', label: 'failed', reason: 'npm test failed (exit 1) after 2m 03s', interrupt: true })
  assert.deepEqual(s.commandAlert({ ...base, exitCode: 0 }), { level: 'quiet', label: 'done', reason: 'npm test finished after 2m 03s' })
  assert.equal(s.commandAlert({ ...base, durationMs: 9_999 }), undefined, 'under the threshold')
  assert.ok(s.commandAlert({ ...base, durationMs: 10_000 }), 'exactly the threshold counts')
  assert.equal(s.commandAlert({ ...base, thresholdSec: 0 }), undefined, 'off')
  assert.equal(s.commandAlert({ ...base, thresholdSec: 60, durationMs: 59_000 }), undefined, 'under the 60 s choice')
  assert.ok(s.commandAlert({ ...base, thresholdSec: 60, durationMs: 61_000 }))
  assert.equal(s.commandAlert({ ...base, unattended: false }), undefined, 'the user is looking')
  assert.equal(s.commandAlert({ ...base, agent: true }), undefined, 'a terminal with an agent state')
  assert.equal(s.commandAlert({ ...base, fullScreen: true }), undefined)
  assert.equal(s.commandAlert({ ...base, command: 'claude --resume' }), undefined)
  assert.equal(s.commandAlert({ ...base, exitCode: undefined }), undefined, 'cannot call an unknown exit either way')
  assert.match(s.commandAlert({ ...base, command: 'x'.repeat(100) }).reason, /^x{59}… failed/)
  assert.match(s.commandAlert({ ...base, command: '' }).reason, /^Command failed/)
})

// ── a terminal with blocks ──

/** Output of the first command: wrapped line, a gap, trailing blanks. */
const FILLER = Array.from({ length: 24 }, (_, i) => `f${i + 1}`)
const OUT1 = ['line1', 'W'.repeat(50), 'line3', ...FILLER]
const COLS = 40
const ROWS = 12

/** An opened 40x12 terminal with two finished commands (ok, then failed) and an open prompt; the screen stub gives rows a height. */
async function withBlocks({ tail = '' } = {}) {
  const id = s.openTerminal({ cwd: 'C:\\work', startup: '' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const sock = await until(() => FakeWebSocket.last, 'a socket')
  s.openRuntime(rt)
  rt.term.resize(COLS, ROWS)
  // jsdom has no layout, so xterm's viewport never scrolls; without it the term moves its own view (what the viewport does in a browser).
  rt.term._core._viewport = undefined
  sock.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null, agent: null })
  const stream = [
    prompt('echo a'), OUT1.join('\r\n'), '\r\n\r\n\r\n', done(0),
    prompt('false'), 'boom\r\n', ...OUT1.map((l) => `${l}\r\n`), done(1),
    osc('133;A'), '$ ', osc('133;B'), tail,
  ].join('')
  sock.push({ type: 'data', data: stream })
  await flush(rt)
  const screen = rt.term.element.querySelector('.xterm-screen')
  assert.ok(screen, 'xterm drew its screen element')
  screen.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: ROWS * 20, width: 400, height: ROWS * 20 })
  return { id, rt, sock, screen }
}

const header = (rt) => rt.holder.querySelector('.wt-bh')
const sticky = (rt) => rt.holder.querySelector('.wt-bsticky')
const hover = (rt, bufferLine) => {
  const y = (bufferLine - rt.term.buffer.active.viewportY) * 20 + 5
  rt.holder.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 50, clientY: y, bubbles: true }))
}
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const button = (rt, action) => header(rt).querySelector(`[data-action="${action}"]`)

function clipboard() {
  const copied = []
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => void copied.push(t) }, configurable: true })
  return copied
}

test('the model finds the blocks and the output text joins wrapped rows and drops the trailing blanks', async () => {
  const { rt } = await withBlocks()
  const [a, b] = rt.blocks.list()
  assert.deepEqual([a.command, a.exitCode, b.command, b.exitCode], ['echo a', 0, 'false', 1])
  const out = s.blockOutput(rt, a)
  assert.ok('ok' in out)
  assert.equal(out.ok.text, OUT1.join('\n'))
  assert.ok(out.ok.text.includes('W'.repeat(50)), 'the 50-character line wrapped over two 40-column rows and is one line again')
  assert.equal(s.blockOutput(rt, b).ok.text, ['boom', ...OUT1].join('\n'))
})

test('hover: the header appears on a command, shows its facts and goes away', async () => {
  const { rt } = await withBlocks()
  const [a, b] = rt.blocks.list()
  assert.equal(header(rt).hidden, true)
  rt.term.scrollToTop()
  hover(rt, a.prompt.line + 2)
  assert.equal(header(rt).hidden, false)
  assert.match(header(rt).querySelector('.wt-bh-cmd').textContent, /^echo a$/)
  assert.equal(header(rt).querySelector('.wt-bh-exit').textContent, '✓')
  assert.equal(header(rt).dataset.state, 'ok')
  assert.match(header(rt).querySelector('.wt-bh-dur').textContent, /^\d+ms$|^\d\.\ds$/)
  assert.match(header(rt).querySelector('.wt-bh-time').textContent, /^\d\d:\d\d$/)
  const fail = b.prompt.line
  rt.term.scrollToLine(fail)
  hover(rt, fail)
  assert.equal(header(rt).dataset.state, 'fail')
  assert.equal(header(rt).querySelector('.wt-bh-exit').textContent, '✗ 1')
  assert.equal(header(rt).querySelector('.wt-bh-cmd').textContent, 'false')
  rt.holder.dispatchEvent(new window.MouseEvent('mouseleave'))
  assert.equal(header(rt).hidden, true)
  // The open prompt (no command) has no header.
  rt.term.scrollToBottom()
  const open = rt.blocks.list().at(-1)
  hover(rt, open.prompt.line)
  assert.equal(header(rt).hidden, true)
})

test('header actions: copy output, copy command, select output, send', async () => {
  const copied = clipboard()
  const { id, rt } = await withBlocks()
  const [a] = rt.blocks.list()
  rt.term.scrollToTop()
  hover(rt, a.prompt.line + 1)
  click(button(rt, 'copy-output'))
  await until(() => copied.length === 1, 'the copy')
  assert.equal(copied[0], OUT1.join('\n'))
  click(button(rt, 'copy-command'))
  await until(() => copied.length === 2, 'the second copy')
  assert.equal(copied[1], 'echo a')
  assert.equal(button(rt, 'copy-output').textContent, '✓', 'the button confirms')
  click(button(rt, 'select'))
  assert.equal(rt.term.hasSelection(), true)
  assert.equal(rt.term.getSelection().replace(/\n/g, ''), OUT1.join('').replace(/\n/g, ''), 'the selection covers exactly the output rows')
  assert.ok(!rt.term.getSelection().endsWith('\n\n'), 'no trailing blank rows selected')
  // Send opens the existing picker with the output as its text.
  s.closeSendMenu()
  click(button(rt, 'send'))
  assert.equal(s.getSendRequest()?.sourceId, id)
  assert.equal(s.getSendRequest()?.text, OUT1.join('\n'))
  s.closeSendMenu()
})

test('header actions are off when the output is partly gone, with the reason as tooltip', async () => {
  const { rt, sock } = await withBlocks()
  const [a] = rt.blocks.list()
  a.outputStart.dispose()
  rt.term.scrollToTop()
  hover(rt, a.prompt.line)
  for (const action of ['copy-output', 'select', 'send']) {
    assert.equal(button(rt, action).disabled, true, action)
    assert.match(button(rt, action).title, /scrolled out/)
  }
  assert.equal(button(rt, 'copy-command').disabled, false)
  const copied = clipboard()
  click(button(rt, 'copy-output'))
  await sleep(20)
  assert.deepEqual(copied, [], 'a disabled button does nothing')
  void sock
})

test('rerun types the command and Enter, only at a prompt', async () => {
  const { rt, sock } = await withBlocks()
  const [a] = rt.blocks.list()
  rt.term.scrollToTop()
  hover(rt, a.prompt.line)
  assert.equal(button(rt, 'rerun').disabled, false)
  click(button(rt, 'rerun'))
  assert.deepEqual(sock.sent.filter((f) => f.type === 'input').map((f) => f.data), ['echo a\r'])
  // The command is now running: the header of an old block says to wait, and the click does nothing.
  sock.push({ type: 'data', data: prompt('echo a') + 'x\r\n' })
  await flush(rt)
  hover(rt, rt.term.buffer.active.viewportY + 1) // the new output moved the view
  assert.equal(button(rt, 'rerun').disabled, true)
  assert.match(button(rt, 'rerun').title, /running/)
  click(button(rt, 'rerun'))
  assert.equal(sock.sent.filter((f) => f.type === 'input').length, 1)
  // Back at a prompt it works again.
  sock.push({ type: 'data', data: done(0) + osc('133;A') + '$ ' + osc('133;B') })
  await flush(rt)
  rt.blockBar.refresh()
  assert.equal(button(rt, 'rerun').disabled, false)
  // And not in a full-screen program.
  rt.term.write(`${ESC}[?1049h`)
  await flush(rt)
  assert.equal(s.rerunBlocked(rt, a) !== undefined, true)
})

// ── navigation ──

const KEY = { prev: { key: 'ArrowUp', ctrlKey: true, shiftKey: true }, next: { key: 'ArrowDown', ctrlKey: true, shiftKey: true }, failed: { key: 'e', ctrlKey: true, shiftKey: true } }
const press = (rt, init) => {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  const consumed = rt.term._core._customKeyEventHandler(event) === false
  return { consumed, prevented: event.defaultPrevented }
}

test('Ctrl+Shift+Up / Down scroll to the previous / next command prompt', async () => {
  const { rt } = await withBlocks()
  const [a, b, open] = rt.blocks.list()
  const buf = () => rt.term.buffer.active
  const top = (line) => Math.min(line, buf().baseY)
  rt.term.scrollToBottom()
  assert.equal(press(rt, KEY.prev).consumed, true)
  assert.equal(buf().viewportY, top(b.prompt.line), 'from the bottom, previous is the last command')
  assert.equal(press(rt, KEY.prev).prevented, true)
  assert.equal(buf().viewportY, top(a.prompt.line))
  assert.equal(press(rt, KEY.prev).consumed, true, 'at the first command the key is still ours')
  assert.equal(buf().viewportY, top(a.prompt.line))
  assert.equal(press(rt, KEY.next).consumed, true)
  assert.equal(buf().viewportY, top(b.prompt.line))
  press(rt, KEY.next)
  press(rt, KEY.next)
  assert.equal(buf().viewportY, buf().baseY, 'past the last command: the bottom')
  void open
})

test('Ctrl+Shift+E jumps to the last failed command, again to the one before, and passes through when none failed', async () => {
  const { rt, sock } = await withBlocks()
  const [, b] = rt.blocks.list()
  const buf = () => rt.term.buffer.active
  rt.term.scrollToTop()
  assert.equal(press(rt, KEY.failed).consumed, true)
  assert.equal(buf().viewportY, Math.min(b.prompt.line, buf().baseY))
  // Another failure appears: the newest is the first stop.
  sock.push({ type: 'data', data: prompt('bad') + 'e\r\n' + done(2) + osc('133;A') + '$ ' + osc('133;B') })
  await flush(rt)
  assert.equal(press(rt, KEY.failed).consumed, true)
  const newest = rt.blocks.list().find((x) => x.command === 'bad')
  assert.equal(buf().viewportY, Math.min(newest.prompt.line, buf().baseY))
  assert.equal(press(rt, KEY.failed).consumed, true)
  assert.equal(buf().viewportY, Math.min(b.prompt.line, buf().baseY), 'repeat: the older failure')
  assert.equal(press(rt, KEY.failed).consumed, true)
  assert.equal(buf().viewportY, Math.min(newest.prompt.line, buf().baseY), 'then it wraps')
})

test('the navigation keys reach the program with no blocks, with only failed-less blocks (E), and on the alternate screen', async () => {
  // No blocks at all: a plain shell.
  const id = s.openTerminal({ cwd: 'C:\\work', startup: '' })
  const plain = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(plain)
  for (const k of Object.values(KEY)) assert.equal(press(plain, k).consumed, false, 'no blocks')
  // Blocks that all succeeded: only the failed jump has nothing to do.
  const { rt, sock } = await withBlocks()
  sock.push({ type: 'data', data: '' })
  rt.blocks.list()[1].exitCode = 0
  assert.equal(press(rt, KEY.failed).consumed, false, 'no failed command: the key is the program\'s')
  assert.equal(press(rt, KEY.prev).consumed, true)
  // A full-screen program owns every key.
  rt.term.write(`${ESC}[?1049h`)
  await flush(rt)
  for (const k of Object.values(KEY)) assert.equal(press(rt, k).consumed, false, 'alternate screen')
})

test('a jump flashes the prompt row with a decoration that is removed again', async () => {
  const { rt } = await withBlocks()
  const [a] = rt.blocks.list()
  let flashed = 0
  const original = rt.term.registerDecoration.bind(rt.term)
  rt.term.registerDecoration = (o) => {
    if (o.width === COLS) flashed++
    return original(o)
  }
  s.jumpToBlock(rt, a)
  assert.equal(flashed, 1)
  assert.equal(rt.term.buffer.active.viewportY, Math.min(a.prompt.line, rt.term.buffer.active.baseY))
})

// ── sticky bar ──

test('the sticky bar names the command while its prompt is above the viewport, and a click jumps back', async () => {
  const { rt } = await withBlocks()
  const [a] = rt.blocks.list()
  const buf = () => rt.term.buffer.active
  rt.term.scrollToLine(a.prompt.line)
  rt.blockBar.refresh()
  assert.equal(sticky(rt).hidden, true, 'the prompt is the top row: nothing is hidden')
  rt.term.scrollToLine(a.prompt.line + 6)
  rt.blockBar.refresh()
  assert.equal(sticky(rt).hidden, false)
  assert.match(sticky(rt).textContent, /^▸ echo a✓/)
  assert.equal(sticky(rt).dataset.state, 'ok')
  click(sticky(rt))
  assert.equal(buf().viewportY, a.prompt.line)
  rt.blockBar.refresh()
  assert.equal(sticky(rt).hidden, true)
  // A full-screen program hides it.
  rt.term.scrollToLine(a.prompt.line + 6)
  rt.term.write(`${ESC}[?1049h`)
  await flush(rt)
  rt.blockBar.refresh()
  assert.equal(sticky(rt).hidden, true)
})

test('a running command shows in the sticky bar and ticks', async () => {
  const { rt, sock } = await withBlocks()
  sock.push({ type: 'data', data: prompt('sleep 100') + Array.from({ length: 30 }, (_, i) => `r${i}`).join('\r\n') + '\r\n' })
  await flush(rt)
  rt.blockBar.refresh()
  const running = rt.blocks.list().at(-1)
  assert.equal(running.state, 'running')
  assert.equal(rt.term.buffer.active.viewportY, rt.term.buffer.active.baseY)
  assert.equal(sticky(rt).hidden, false, 'the prompt scrolled off the top while the output runs on')
  assert.equal(sticky(rt).dataset.state, 'run')
  assert.match(sticky(rt).textContent, /sleep 100.*running/)
  rt.blockBar.dispose()
})

// ── alerts ──

/** Run a command that "took" `seconds`, ending with `code`. */
async function longCommand(rt, sock, { command = 'npm test', seconds = 123, code = 1 } = {}) {
  sock.push({ type: 'data', data: prompt(command) + 'working\r\n' })
  await flush(rt)
  const running = rt.blocks.list().at(-1)
  running.startedAt -= seconds * 1000
  sock.push({ type: 'data', data: done(code) + osc('133;A') + '$ ' + osc('133;B') })
  await flush(rt)
}
async function attached(extra = {}) {
  const id = s.openTerminal({ cwd: 'C:\\work', startup: '' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const sock = await until(() => FakeWebSocket.last, 'a socket')
  sock.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null, agent: null, ...extra })
  return { id, rt, sock }
}

test('a long failed command in an unattended terminal raises a quiet "failed" flag that interrupts, a long success a plain "done"', async () => {
  const { rt, sock } = await attached()
  await longCommand(rt, sock)
  assert.equal(rt.attention, true)
  assert.equal(rt.attentionLevel, 'quiet')
  assert.equal(rt.attentionLabel, 'failed')
  assert.equal(rt.attentionReason, 'npm test failed (exit 1) after 2m 03s')
  s.clearAttention(rt)
  await longCommand(rt, sock, { command: 'npm run build', code: 0 })
  assert.equal(rt.attentionLabel, 'done')
  assert.equal(rt.attentionLevel, 'quiet')
})

test('no flag for a short command, with the setting off, for claude, with an agent state, or when the user is looking', async () => {
  const { id, rt, sock } = await attached()
  await longCommand(rt, sock, { seconds: 3 })
  assert.equal(rt.attention, false, 'short')
  s.setCommandNotifySeconds(0)
  await longCommand(rt, sock)
  assert.equal(rt.attention, false, 'off')
  s.setCommandNotifySeconds(30)
  assert.equal(s.getPrefs().commandNotifySec, 30)
  await longCommand(rt, sock, { seconds: 20 })
  assert.equal(rt.attention, false, 'under the 30 s setting')
  await longCommand(rt, sock, { seconds: 40 })
  assert.equal(rt.attention, true, 'over it')
  s.clearAttention(rt)
  s.setCommandNotifySeconds(10)
  await longCommand(rt, sock, { command: 'claude --resume', code: 1 })
  assert.equal(rt.attention, false, 'claude')
  rt.agent = { provider: 'claude', state: 'working', detail: '', since: Date.now() }
  await longCommand(rt, sock)
  assert.equal(rt.attention, false, 'a terminal with an agent state')
  rt.agent = { provider: 'claude', state: 'ended', detail: '', since: Date.now() }
  await longCommand(rt, sock)
  assert.equal(rt.attention, true, 'an ended agent no longer counts')
  s.clearAttention(rt)
  // The terminal in front of the user: no flag.
  rt.agent = undefined
  const hasFocus = window.document.hasFocus
  window.document.hasFocus = () => true
  s.setViewMounted(true)
  s.focusWin(id)
  try {
    await longCommand(rt, sock)
    assert.equal(rt.attention, false, 'attended')
  } finally {
    window.document.hasFocus = hasFocus
    s.setViewMounted(false)
  }
})

test('a command that used the alternate screen (an editor) raises nothing', async () => {
  const { rt, sock } = await attached()
  sock.push({ type: 'data', data: prompt('vim notes.txt') + `${ESC}[?1049h` + 'editing' })
  await flush(rt)
  rt.blocks.list().at(-1).startedAt -= 300_000
  sock.push({ type: 'data', data: `${ESC}[?1049l` + done(1) + osc('133;A') + '$ ' + osc('133;B') })
  await flush(rt)
  assert.equal(rt.attention, false)
})

test('the setting only accepts the offered choices', () => {
  assert.deepEqual([...s.COMMAND_NOTIFY_CHOICES], [0, 5, 10, 30, 60])
  s.setCommandNotifySeconds(7)
  assert.equal(s.getPrefs().commandNotifySec, 10, 'anything else falls back to the default')
  s.setCommandNotifySeconds(5)
  assert.equal(s.getPrefs().commandNotifySec, 5)
})
