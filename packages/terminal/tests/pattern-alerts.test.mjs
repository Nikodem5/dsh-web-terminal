// Pattern alerts: validation at save time, line assembly across chunks, and the badge a match raises.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

let s

before(async () => {
  s = await loadStore()
})

after(() => {
  quiesceStores()
  s.closeAll()
  window.close()
})

beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  window.localStorage.clear()
  FakeWebSocket.reset()
  s.getPrefs().patternAlerts = s.defaultPatternAlerts()
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

const pattern = (over = {}) => ({ id: 'p1', name: '', text: 'error', regex: false, caseSensitive: false, scope: 'all', enabled: true, level: 'urgent', cooldownSec: 30, ...over })
/** Feed chunks through the pure scanner; returns the lines that hit. */
function scan(patterns, chunks, { terminal = 't1', now = 0 } = {}) {
  const state = s.newScanState()
  const matchers = s.activeMatchers(patterns, terminal)
  const lines = []
  for (const chunk of chunks) for (const hit of s.scanChunk(state, chunk, matchers, now)) lines.push(hit.line)
  return { lines, state }
}

// ── shipped examples ──

test('two examples ship, both switched off', () => {
  const examples = s.getPrefs().patternAlerts
  assert.equal(examples.length, 2)
  assert.ok(examples.every((p) => p.enabled === false))
  assert.equal(examples[0].text, 'Do you want to proceed?')
  assert.equal(examples[1].regex, true)
})

test('the test-failure example matches failure lines and not a clean run', () => {
  const on = s.defaultPatternAlerts().map((p) => ({ ...p, enabled: true }))
  const { lines } = scan([on[1]], ['FAIL src/a.test.js\r\n', 'Tests: 3 failed, 9 passed\r\n', 'not ok 4 - thing\r\n', '12 passed, 0 failed\r\n', 'all good\r\n'])
  assert.deepEqual(lines, ['FAIL src/a.test.js'])
  // Cooldown holds back the rest within one test; a long cooldown-free run shows them all.
  const { lines: all } = scan([{ ...on[1], cooldownSec: 0 }], ['FAIL src/a.test.js\r\n', 'Tests: 3 failed, 9 passed\r\n', 'not ok 4 - thing\r\n', '12 passed, 0 failed\r\n'])
  assert.deepEqual(all, ['FAIL src/a.test.js', 'Tests: 3 failed, 9 passed', 'not ok 4 - thing'])
})

test('a disabled pattern never matches; the proceed example does once switched on', () => {
  const [proceed] = s.defaultPatternAlerts()
  assert.deepEqual(scan([proceed], ['Do you want to proceed?\n']).lines, [])
  assert.deepEqual(scan([{ ...proceed, enabled: true }], ['  Do you want to proceed?  \n']).lines, ['Do you want to proceed?'])
})

// ── validation ──

test('checkPatternAlert refuses empty, invalid, over-long and empty-matching regexes', () => {
  const bad = (over) => s.checkPatternAlert(pattern(over))
  assert.equal(bad({ text: '   ' }).ok, false)
  assert.match(bad({ text: '(', regex: true }).error, /not a valid regular expression/i)
  assert.match(bad({ text: 'a'.repeat(201), regex: true }).error, /at most 200/)
  assert.match(bad({ text: 'a'.repeat(201) }).error, /at most 200/)
  assert.match(bad({ text: 'a*', regex: true }).error, /empty line/)
  assert.match(bad({ text: '(a+)+$', regex: true }).error, /repeated group/)
  assert.match(bad({ text: '(.*)*x', regex: true }).error, /repeated group/)
  assert.equal(bad({ text: 'a+b', regex: true }).ok, true)
  assert.equal(bad({ text: '(error|fail)ed?', regex: true }).ok, true)
  // The same characters are fine as plain text.
  assert.equal(bad({ text: '(' }).ok, true)
})

test('checkPatternAlert normalises the rest: cooldown clamped, name cut, unknown level urgent, fresh id', () => {
  const ok = s.checkPatternAlert({ text: 'x', name: 'n'.repeat(80), cooldownSec: 99999, level: 'weird', id: 'bad id!' })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.name.length, 40)
  assert.equal(ok.value.cooldownSec, 3600)
  assert.equal(ok.value.level, 'urgent')
  assert.match(ok.value.id, /^[\w.-]+$/)
  assert.equal(s.checkPatternAlert({ text: 'x', cooldownSec: -4 }).value.cooldownSec, 0)
})

test('savePatternAlert adds, replaces by id, refuses a bad one without changing the list, and caps the count', () => {
  s.getPrefs().patternAlerts = []
  assert.equal(s.savePatternAlert({ id: 'a', text: 'one' }), undefined)
  assert.equal(s.savePatternAlert({ id: 'a', text: 'two' }), undefined)
  assert.deepEqual(s.getPrefs().patternAlerts.map((p) => p.text), ['two'])
  assert.match(s.savePatternAlert({ id: 'b', text: '(', regex: true }), /regular expression/)
  assert.equal(s.getPrefs().patternAlerts.length, 1)
  for (let i = 0; i < 25; i++) s.savePatternAlert({ id: `n${i}`, text: `t${i}` })
  assert.equal(s.getPrefs().patternAlerts.length, s.PATTERNS_MAX)
  assert.match(s.savePatternAlert({ id: 'overflow', text: 'z' }), /At most/)
  s.removePatternAlert('a')
  assert.equal(s.getPrefs().patternAlerts.some((p) => p.id === 'a'), false)
  s.setPatternAlertEnabled('n0', false)
  assert.equal(s.getPrefs().patternAlerts.find((p) => p.id === 'n0').enabled, false)
})

test('stored patterns are re-validated on load: bad ones dropped, duplicates removed, none stored keeps the examples', () => {
  const cleaned = s.cleanPatternAlerts([pattern({ id: 'ok' }), pattern({ id: 'ok', text: 'dup' }), pattern({ id: 'bad', text: '(', regex: true }), 'junk', null])
  assert.deepEqual(cleaned.map((p) => p.id), ['ok'])
  assert.equal(s.cleanPatternAlerts(undefined).length, 2)
  assert.deepEqual(s.cleanPatternAlerts([]), [], 'an emptied list stays empty')
})

// ── matching ──

test('stripAnsi removes colours, cursor moves, titles and hyperlinks', () => {
  assert.equal(s.stripAnsi('\x1b[31mError\x1b[0m: \x1b[1;4mboom\x1b[m'), 'Error: boom')
  assert.equal(s.stripAnsi('\x1b]0;title\x07done\x1b[2K\x1b[1G'), 'done')
  assert.equal(s.stripAnsi('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'link')
  assert.equal(s.stripAnsi('a\tb\x08c'), 'a bc')
  assert.equal(s.stripAnsi('plain'), 'plain')
})

test('a line split across chunks matches once it is complete, not before', () => {
  const { lines } = scan([pattern({ text: 'Do you want to proceed?' })], ['Do you want', ' to pro', 'ceed?', '\r\nnext'])
  assert.deepEqual(lines, ['Do you want to proceed?'])
  assert.deepEqual(scan([pattern()], ['an error with no newline yet']).lines, [])
})

test('an escape sequence split across chunks does not hide or fake a match', () => {
  const { lines } = scan([pattern({ text: 'error: bad' })], ['\x1b[3', '1merror: b', 'ad\x1b[0', 'm\n'])
  assert.deepEqual(lines, ['error: bad'])
})

test('CRLF, LF and a lone CR end lines; a CRLF split between chunks makes no extra line', () => {
  const { lines } = scan([pattern({ cooldownSec: 0 })], ['error one\r', '\nerror two\nerror three\rerror four\r\n'])
  assert.deepEqual(lines, ['error one', 'error two', 'error three', 'error four'])
})

test('case is ignored unless asked for; regex flags follow it', () => {
  assert.deepEqual(scan([pattern({ text: 'ERROR' })], ['an Error here\n']).lines, ['an Error here'])
  assert.deepEqual(scan([pattern({ text: 'ERROR', caseSensitive: true })], ['an Error here\n']).lines, [])
  assert.deepEqual(scan([pattern({ text: 'err(or)?s?\\b', regex: true })], ['ERRORS found\n']).lines, ['ERRORS found'])
  assert.deepEqual(scan([pattern({ text: 'err(or)?s?\\b', regex: true, caseSensitive: true })], ['ERRORS found\n']).lines, [])
})

test('the cooldown is per pattern: the same pattern waits, another does not, and it ends', () => {
  const a = pattern({ id: 'a', cooldownSec: 10 })
  const b = pattern({ id: 'b', text: 'warn', cooldownSec: 10 })
  const state = s.newScanState()
  const m = s.activeMatchers([a, b], 't1')
  const ids = (now, text) => s.scanChunk(state, text, m, now).map((h) => h.pattern.id)
  assert.deepEqual(ids(1000, 'error and warn\n'), ['a', 'b'])
  assert.deepEqual(ids(5000, 'error again\n'), [], 'inside the cooldown')
  assert.deepEqual(ids(5000, 'warn only\n'), [])
  assert.deepEqual(ids(11_001, 'error again\n'), ['a'], 'a has cooled down')
  assert.deepEqual(ids(11_002, 'warn now\n'), ['b'])
  // Within one chunk a pattern also hits once.
  assert.deepEqual(ids(60_000, 'error\nerror\nerror\n'), ['a'])
})

test('scope: a pattern for one terminal ignores the others', () => {
  const only = pattern({ scope: 't2' })
  assert.deepEqual(scan([only], ['error\n'], { terminal: 't1' }).lines, [])
  assert.deepEqual(scan([only], ['error\n'], { terminal: 't2' }).lines, ['error'])
})

test('a line is cut to 2000 characters, and an endless line never grows memory past the cap', () => {
  const tail = scan([pattern({ text: 'needle' })], [`${'x'.repeat(2100)}needle\n`])
  assert.deepEqual(tail.lines, [], 'text past the line cap is not looked at')
  const head = scan([pattern({ text: 'needle' })], [`needle${'x'.repeat(5000)}\n`])
  assert.equal(head.lines.length, 1)
  assert.equal(head.lines[0].length, s.LINE_MAX)
  const state = s.newScanState()
  const m = s.activeMatchers([pattern({ text: 'needle' })], 't1')
  for (let i = 0; i < 200; i++) s.scanChunk(state, 'y'.repeat(10_000), m, 0)
  assert.ok(state.partial.length <= s.RAW_MAX)
  assert.equal(state.overflow, true)
  assert.equal(s.scanChunk(state, 'z\nneedle here\n', m, 0).length, 1, 'the next line is read normally')
  assert.equal(state.overflow, false)
})

test('with nothing enabled for a terminal no line is kept', () => {
  const state = s.newScanState()
  s.scanChunk(state, 'half a line', s.activeMatchers([pattern({ enabled: false })], 't1'), 0)
  assert.equal(state.partial, '')
})

test('a pattern edited in place is matched by its new text', () => {
  assert.deepEqual(scan([pattern({ text: 'old' })], ['old\n']).lines, ['old'])
  assert.deepEqual(scan([pattern({ text: 'new' })], ['old\n', 'new\n']).lines, ['new'])
})

// ── the badge ──

function fakeRuntime(id) {
  return {
    id, conn: 'live', title: '', agent: undefined, hostBusy: undefined, activity: 'idle', lastOutputAt: 0, hungRaised: false,
    attention: false, attentionLevel: null, attentionLabel: '', attentionReason: '',
    socket: null, timer: undefined, killed: false, term: { dispose() {} }, holder: { remove() {} },
  }
}

test('a matching line raises attention naming the pattern, with the line in the tooltip', () => {
  const id = s.openTerminal({ cwd: 'C:\\a' })
  const rt = fakeRuntime(id)
  s.runtimes.set(id, rt)
  s.getPrefs().patternAlerts = [pattern({ name: 'Boom', text: 'boom', level: 'quiet' })]
  s.feedPatternAlerts(rt, 'all fine\r\nthe \x1b[31mboom\x1b[0m happened\r\n')
  assert.equal(rt.attention, true)
  assert.equal(rt.attentionLabel, 'Boom')
  assert.equal(rt.attentionLevel, 'quiet')
  assert.match(rt.attentionReason, /Boom.*the boom happened/)
})

test('it works for a minimized window and never for an unknown terminal', () => {
  const id = s.openTerminal({ cwd: 'C:\\a' })
  const rt = fakeRuntime(id)
  s.runtimes.set(id, rt)
  s.updateWin(id, { minimized: true })
  s.getPrefs().patternAlerts = [pattern({ text: 'proceed?', level: 'urgent' })]
  s.feedPatternAlerts(rt, 'Do you want to proceed?\n')
  assert.equal(rt.attentionLevel, 'urgent')
  assert.equal(rt.attentionLabel, 'proceed?', 'unnamed: the badge shows the text')
  const ghost = fakeRuntime('not-a-window')
  s.feedPatternAlerts(ghost, 'Do you want to proceed?\n')
  assert.equal(ghost.attention, false)
})

test('through a real runtime: live frames raise it (even minimized and split), a reattach replay does not', async () => {
  const id = s.openTerminal({ cwd: 'C:\\work' })
  s.updateWin(id, { minimized: true })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const sock = await until(() => FakeWebSocket.last, 'the socket')
  s.getPrefs().patternAlerts = [pattern({ name: 'Fail', text: 'build failed' })]
  sock.push({ type: 'attached', created: true, replay: 'build failed\r\n', exited: false, exitCode: null, agent: null })
  await until(() => rt.conn === 'live', 'live')
  assert.equal(rt.attention, false, 'the replay is history')
  sock.push({ type: 'data', data: '\x1b[31mbuild fa' })
  sock.push({ type: 'data', data: 'iled\x1b[0m\r\n' })
  assert.equal(rt.attention, true)
  assert.equal(rt.attentionLabel, 'Fail')
  s.disposeRuntime(id, false)
})
