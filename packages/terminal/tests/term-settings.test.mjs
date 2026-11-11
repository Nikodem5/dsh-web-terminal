// Scrollback size and cursor settings (src/client/term-prefs.ts, term-options.ts): bounds, live apply, loading from storage.
//
//   node --test tests/term-settings.test.mjs

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

const PREFS_KEY = 'dsh.web-terminal.prefs.v1'
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
  s.setScrollback(s.SCROLLBACK_DEFAULT)
  s.setCursorStyle('block')
  s.setCursorBlink(true)
  quiesceStores()
})
afterEach(() => quiesceStores())

const open = () => {
  const id = s.openTerminal({ cwd: 'C:\\work' })
  return s.ensureRuntime(s.getWins().find((w) => w.id === id))
}

test('defaults match what terminals did before the settings existed', () => {
  assert.deepEqual(s.DEFAULT_TERM, { scrollback: 5000, cursorStyle: 'block', cursorBlink: true, copyOnSelect: false })
  const rt = open()
  assert.equal(rt.term.options.scrollback, 5000)
  assert.equal(rt.term.options.cursorStyle, 'block')
  assert.equal(rt.term.options.cursorBlink, true)
})

test('clampScrollback: whole lines inside the bounds, the default for anything that is not a number', () => {
  assert.equal(s.clampScrollback(2000), 2000)
  assert.equal(s.clampScrollback(1234.6), 1235)
  assert.equal(s.clampScrollback('3000'), 3000)
  assert.equal(s.clampScrollback(1), s.SCROLLBACK_MIN)
  assert.equal(s.clampScrollback(-50), s.SCROLLBACK_MIN)
  assert.equal(s.clampScrollback(1e9), s.SCROLLBACK_MAX)
  assert.equal(s.clampScrollback(Infinity), s.SCROLLBACK_DEFAULT, 'not finite: the default, not the maximum')
  for (const bad of [NaN, '', '  ', 'lots', null, undefined, {}, []]) assert.equal(s.clampScrollback(bad), s.SCROLLBACK_DEFAULT, String(bad))
  assert.ok(s.SCROLLBACK_MIN >= 100 && s.SCROLLBACK_MAX <= 100_000, 'sane bounds')
})

test('a scrollback change reaches every open terminal at once, within the bounds', () => {
  const a = open()
  const b = open()
  s.setScrollback(12_000)
  assert.equal(a.term.options.scrollback, 12_000)
  assert.equal(b.term.options.scrollback, 12_000)
  s.setScrollback(10)
  assert.equal(a.term.options.scrollback, s.SCROLLBACK_MIN)
  s.setScrollback(10_000_000)
  assert.equal(b.term.options.scrollback, s.SCROLLBACK_MAX)
  s.setScrollback(Number('abc'))
  assert.equal(a.term.options.scrollback, s.SCROLLBACK_DEFAULT)
})

test('lowering the scrollback trims the history that is kept', async () => {
  const rt = open()
  await new Promise((resolve) => rt.term.write(Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\r\n') + '\r\n', resolve))
  const before = rt.term.buffer.active.length
  assert.ok(before > 1500)
  s.setScrollback(s.SCROLLBACK_MIN)
  assert.ok(rt.term.buffer.active.length <= s.SCROLLBACK_MIN + rt.term.rows, `kept ${rt.term.buffer.active.length}`)
})

test('cursor style and blink apply live and to terminals opened later', () => {
  const rt = open()
  s.setCursorStyle('bar')
  s.setCursorBlink(false)
  assert.equal(rt.term.options.cursorStyle, 'bar')
  assert.equal(rt.term.options.cursorBlink, false)
  s.setCursorStyle('underline')
  assert.equal(rt.term.options.cursorStyle, 'underline')
  const later = open()
  assert.equal(later.term.options.cursorStyle, 'underline')
  assert.equal(later.term.options.cursorBlink, false)
  assert.equal(later.term.options.scrollback, s.getPrefs().term.scrollback)
})

test('an unknown cursor style falls back to block', () => {
  s.setCursorStyle('bar')
  s.setCursorStyle('rainbow')
  assert.equal(s.getPrefs().term.cursorStyle, 'block')
})

test('cleanTermPrefs repairs stored values field by field', () => {
  assert.deepEqual(s.cleanTermPrefs(undefined), s.DEFAULT_TERM)
  assert.deepEqual(s.cleanTermPrefs([]), s.DEFAULT_TERM)
  assert.deepEqual(s.cleanTermPrefs({ scrollback: 20_000, cursorStyle: 'underline', cursorBlink: false, copyOnSelect: true }), { scrollback: 20_000, cursorStyle: 'underline', cursorBlink: false, copyOnSelect: true })
  assert.deepEqual(s.cleanTermPrefs({ scrollback: '9', cursorStyle: 'beam', cursorBlink: 'no', copyOnSelect: 1 }), s.DEFAULT_TERM)
  assert.equal(s.cleanTermPrefs({ scrollback: 9e12 }).scrollback, s.SCROLLBACK_MAX)
  assert.equal(s.cleanTermPrefs({ scrollback: 3 }).scrollback, s.SCROLLBACK_MIN)
  assert.equal(s.cleanTermPrefs({ scrollback: NaN }).scrollback, s.SCROLLBACK_DEFAULT)
  assert.equal(s.cleanTermPrefs({ scrollback: null }).scrollback, s.SCROLLBACK_DEFAULT)
})

test('the settings are saved with the preferences and a damaged record cannot break loading', async () => {
  s.setScrollback(8000)
  s.setCursorStyle('bar')
  s.setCursorBlink(false)
  s.setCopyOnSelect(true)
  const deadline = Date.now() + 10_000
  const saved = () => JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}').term
  while (saved()?.scrollback !== 8000 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(saved(), { scrollback: 8000, cursorStyle: 'bar', cursorBlink: false, copyOnSelect: true })

  const f = await loadStore({ fresh: true })
  window.localStorage.setItem(PREFS_KEY, JSON.stringify({ term: { scrollback: 'x', cursorStyle: 7, cursorBlink: null, copyOnSelect: 'yes' }, sound: false }))
  f.hydrate()
  assert.deepEqual(f.getPrefs().term, f.DEFAULT_TERM)
  assert.equal(f.getPrefs().sound, false, 'the rest of the preferences still load')
  f.closeAll()
  quiesceStores()

  const g = await loadStore({ fresh: true })
  window.localStorage.setItem(PREFS_KEY, JSON.stringify({ sound: true }))
  g.hydrate()
  assert.deepEqual(g.getPrefs().term, g.DEFAULT_TERM, 'preferences saved before these settings existed')
  g.closeAll()
  quiesceStores()
})
