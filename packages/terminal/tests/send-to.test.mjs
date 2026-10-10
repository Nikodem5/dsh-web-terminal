// Send selection to another terminal: the pure text/ordering parts, then real runtimes.
//
//   node --test tests/send-to.test.mjs

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
  window.confirm = () => true
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const flush = (rt) => new Promise((resolve) => rt.term.write('', resolve))
const attached = (extra = {}) => ({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null, ...extra })

/** Open a terminal, attach it, and return its runtime and socket. */
async function open(opts = {}) {
  const count = FakeWebSocket.instances.length
  const id = s.openTerminal({ cwd: 'C:\\work', ...opts })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt)
  const sock = await until(() => FakeWebSocket.instances[count], 'a socket')
  sock.push(attached())
  return { id, rt, sock }
}
const inputs = (sock) => sock.sent.filter((f) => f.type === 'input')

test('cleanSelection: LF, trailing blanks trimmed per line, blank edges dropped, control chars removed', () => {
  assert.equal(s.cleanSelection('\r\n  a  \r\nb\t\r\n\r\n'), '  a\nb')
  assert.equal(s.cleanSelection('x\x1b[201~y\x07'), 'x[201~y')
  assert.equal(s.cleanSelection('a\n\nb'), 'a\n\nb', 'inner blank lines stay')
})

test('frameCodeBlock: fenced, longer fence when the text has backticks', () => {
  assert.equal(s.frameCodeBlock('err'), '```\nerr\n```\n')
  assert.equal(s.frameCodeBlock('a ``` b'), '````\na ``` b\n````\n')
})

test('pasteInput: bracketed wraps with CR newlines; raw never ends in a newline', () => {
  assert.equal(s.pasteInput('a\nb', true), '\x1b[200~a\rb\x1b[201~')
  assert.equal(s.pasteInput('a\nb\n', false), 'a\rb')
  assert.equal(s.pasteInput('```\nx\n```\n', true), '\x1b[200~```\rx\r```\r\x1b[201~')
})

test('needsConfirm: over 32 KB asks; multi-line without paste mode asks; bracketed multi-line does not', () => {
  assert.equal(s.needsConfirm('x'.repeat(s.MAX_SEND_CHARS + 1), true), 'big')
  assert.equal(s.needsConfirm('a\nb', false), 'lines')
  assert.equal(s.needsConfirm('a\nb', true), null)
  assert.equal(s.needsConfirm('a\n', false), null, 'one line plus its newline is one line')
})

test('orderTargets: agents first, list order kept, source and offline terminals left out', () => {
  const t = (id, agent, live = true) => ({ id, name: id, agent, live, activity: 'idle' })
  const out = s.orderTargets([t('a', false), t('src', true), t('b', true), t('c', false, false), t('d', false), t('e', true)], 'src')
  assert.deepEqual(out.map((x) => x.id), ['b', 'e', 'a', 'd'])
})

test('isAgentTarget: a reporting agent counts until it ends; otherwise a claude startup does', () => {
  assert.equal(s.isAgentTarget('npm run dev', { state: 'working' }), true)
  assert.equal(s.isAgentTarget('claude', { state: 'ended' }), false)
  assert.equal(s.isAgentTarget('claude --resume', undefined), true)
  assert.equal(s.isAgentTarget('claude-code-router', undefined), false)
  assert.equal(s.isAgentTarget(undefined, undefined), false)
})

test('a selection sent to a target with bracketed paste is wrapped on the target socket only, and focuses it', async () => {
  const src = await open({ title: 'Build', nameManual: true })
  const dst = await open({ title: 'Claude', nameManual: true, startup: 'claude' })
  dst.rt.term.write('\x1b[?2004h')
  await flush(dst.rt)
  src.rt.term.write('error: boom   \r\nat x.ts:1\r\n')
  await flush(src.rt)
  src.rt.term.selectAll()
  const sentBefore = inputs(src.sock).length
  assert.ok(s.openSendMenu(src.rt))
  assert.equal(s.sendTargets(src.id)[0].id, dst.id)
  assert.equal(s.sendSelection(s.getSendRequest().text, dst.id), true)
  const data = inputs(dst.sock).map((f) => f.data)
  assert.equal(data.length, 1)
  assert.match(data[0], /^\x1b\[200~```\rerror: boom\rat x\.ts:1\r```\r\x1b\[201~$/)
  assert.equal(inputs(src.sock).length, sentBefore, 'nothing typed into the source')
  assert.equal(s.getFocusId(), dst.id)
})

test('a minimized target is restored; a plain shell gets the text unframed and raw', async () => {
  await open()
  const dst = await open({ title: 'sh', nameManual: true })
  s.updateWin(dst.id, { minimized: true })
  assert.equal(s.sendSelection('one line\n', dst.id), true)
  assert.deepEqual(inputs(dst.sock).map((f) => f.data), ['one line'], 'no Enter, no code block')
  assert.equal(s.getWins().find((w) => w.id === dst.id).minimized, false)
})

test('the code-block setting turns the framing off for agents', async () => {
  await open()
  const dst = await open({ startup: 'claude' })
  s.setSendCodeBlock(false)
  s.sendSelection('x', dst.id)
  assert.deepEqual(inputs(dst.sock).map((f) => f.data), ['x'])
  s.setSendCodeBlock(true)
})

test('a send over 32 KB asks first and is dropped when declined', async () => {
  await open()
  const dst = await open()
  let asked = 0
  window.confirm = () => (asked++, false)
  assert.equal(s.sendSelection('y'.repeat(s.MAX_SEND_CHARS + 10), dst.id), false)
  assert.equal(asked, 1)
  assert.equal(inputs(dst.sock).length, 0)
})

test('right-click opens the picker only with a selection (and, under mouse tracking, only with Shift)', async () => {
  const src = await open()
  const click = (init = {}) => {
    const e = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6, ...init })
    src.rt.holder.dispatchEvent(e)
    return e
  }
  src.rt.term.write('hello\r\n')
  await flush(src.rt)
  assert.equal(click().defaultPrevented, false, 'no selection: default behaviour')
  assert.equal(s.getSendRequest(), null)
  src.rt.term.selectAll()
  assert.equal(click().defaultPrevented, true)
  assert.equal(s.getSendRequest().sourceId, src.id)
  s.closeSendMenu()
  src.rt.term.write('\x1b[?1000h')
  await flush(src.rt)
  src.rt.term.selectAll()
  assert.equal(click().defaultPrevented, false, 'a program tracking the mouse keeps its right-click')
  assert.equal(s.getSendRequest(), null)
  assert.equal(click({ shiftKey: true }).defaultPrevented, true, 'Shift+right-click is the escape hatch')
  assert.ok(s.getSendRequest())
})

test('Ctrl+Shift+S opens the picker with a selection and passes through without one', async () => {
  const src = await open()
  src.rt.term.write('hello\r\n')
  await flush(src.rt)
  const key = () => src.rt.term.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  key()
  assert.equal(s.getSendRequest(), null)
  src.rt.term.selectAll()
  key()
  assert.equal(s.getSendRequest()?.sourceId, src.id)
})

test('send to a new Claude terminal waits for the typed command, a quiet screen and paste mode', async () => {
  Object.assign(s.startupTiming, { minMs: 20, settleMs: 40, maxMs: 300 })
  const src = await open({ cwd: 'C:\\proj' })
  s.sendToNewClaude('boom', src.id)
  const win = await until(() => s.getWins().find((w) => w.startup === 'claude'), 'the new window')
  assert.equal(win.cwd, 'C:\\proj')
  // The view renders the window (creating its runtime); here the test does.
  const rt = s.ensureRuntime(win)
  s.openRuntime(rt)
  const sock = await until(() => FakeWebSocket.last !== src.sock && FakeWebSocket.last, 'its socket')
  sock.push(attached({ created: true }))
  await until(() => inputs(sock).length > 0, 'the claude command', 4000)
  await sleep(1200)
  assert.equal(inputs(sock).length, 1, 'not sent while paste mode is off')
  rt.term.write('\x1b[?2004h')
  await until(() => inputs(sock).length === 2, 'the send', 3000)
  assert.equal(inputs(sock)[1].data, '\x1b[200~```\rboom\r```\r\x1b[201~')
})
