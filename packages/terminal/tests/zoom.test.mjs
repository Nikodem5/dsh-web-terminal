// Ctrl+wheel font zoom per terminal (src/client/zoom.ts, term-prefs.ts) and Ctrl+0 to reset it.
//
//   node --test tests/zoom.test.mjs

import { test, before, beforeEach, afterEach, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

const LAYOUT_KEY = 'dsh.web-terminal.layout.v1'
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
  s.setFont({ ...s.DEFAULT_FONT })
  quiesceStores()
})
afterEach(() => {
  mock.timers.reset()
  quiesceStores()
})

const wheel = (el, init) => {
  const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}
const winOf = (id) => s.getWins().find((w) => w.id === id)

/** A terminal with its runtime and a spy standing in for the refit that follows a zoom. */
function open() {
  const id = s.openTerminal({ cwd: 'C:\\work' })
  const rt = s.ensureRuntime(winOf(id))
  s.openRuntime(rt)
  return { id, rt }
}

// ── pure ──

test('wheelSteps: a notch is one step, scrolling up zooms in', () => {
  assert.deepEqual(s.wheelSteps(0, -100, 0), { steps: 1, acc: 0 })
  assert.deepEqual(s.wheelSteps(0, 100, 0), { steps: -1, acc: 0 })
})

test('wheelSteps: small trackpad deltas add up to whole steps and the rest carries over', () => {
  let acc = 0
  let total = 0
  for (let i = 0; i < 25; i++) {
    const r = s.wheelSteps(acc, -10, 0)
    acc = r.acc
    total += r.steps
  }
  assert.equal(total, 2, '250 units of wheel = two steps')
  assert.equal(acc, -50, 'the remaining half step is kept')
})

test('wheelSteps: the direction flipping or an idle wheel drops the carried part', () => {
  assert.deepEqual(s.wheelSteps(-60, 100, 0), { steps: -1, acc: 0 })
  assert.deepEqual(s.wheelSteps(-60, -30, 0, s.WHEEL_IDLE_MS + 1), { steps: 0, acc: -30 })
})

test('wheelSteps: lines and pages are scaled, one event never jumps more than 3 steps, junk is ignored', () => {
  assert.equal(s.wheelSteps(0, -3, 1).steps, 1, 'three lines is about one notch')
  assert.equal(s.wheelSteps(0, -1, 2).steps, 3)
  assert.equal(s.wheelSteps(0, -5000, 0).steps, 3)
  assert.deepEqual(s.wheelSteps(0, NaN, 0), { steps: 0, acc: 0 })
  assert.deepEqual(s.wheelSteps(0, 0, 0), { steps: 0, acc: 0 })
})

test('cleanZoom and zoomedSize keep the font inside the 8-32 px bounds', () => {
  assert.equal(s.cleanZoom(3), 3)
  assert.equal(s.cleanZoom(0), 0, '0 is a real value')
  assert.equal(s.cleanZoom(2.6), 3)
  assert.equal(s.cleanZoom(999), 24)
  assert.equal(s.cleanZoom(-999), -24)
  for (const bad of ['3', null, undefined, NaN, Infinity, {}, [], true]) assert.equal(s.cleanZoom(bad), undefined, String(bad))
  assert.equal(s.zoomedSize(14, 4), 18)
  assert.equal(s.zoomedSize(14, 100), 32)
  assert.equal(s.zoomedSize(14, -100), 8)
})

test('a zoomed terminal uses its size as it is; without a zoom the shrink-to-fit still applies', () => {
  assert.ok(s.effectiveFontSize(300) < s.getPrefs().font.size, 'a narrow window shrinks')
  assert.equal(s.effectiveFontSize(300, 2), s.getPrefs().font.size + 2)
  assert.equal(s.effectiveFontSize(300, 0), s.getPrefs().font.size, 'a zoom of 0 is still the user\'s choice')
})

// ── in the terminal ──

test('Ctrl+wheel over a terminal zooms its font one pixel per notch and claims the event', () => {
  const { id, rt } = open()
  const base = s.getPrefs().font.size
  const up = wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.equal(up.defaultPrevented, true, 'the page must not zoom')
  assert.equal(rt.term.options.fontSize, base + 1)
  assert.equal(winOf(id).zoom, 1)
  wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.equal(winOf(id).zoom, 2)
  wheel(rt.holder, { ctrlKey: true, deltaY: 100 })
  assert.equal(winOf(id).zoom, 1)
  assert.equal(rt.term.options.fontSize, base + 1)
})

test('the wheel reaches xterm untouched without Ctrl (it scrolls)', () => {
  const { id, rt } = open()
  const event = wheel(rt.holder, { deltaY: -100 })
  assert.equal(event.defaultPrevented, false)
  assert.equal(winOf(id).zoom, undefined)
})

test('zooming one terminal leaves the others alone', () => {
  const a = open()
  const b = open()
  wheel(a.rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.equal(winOf(a.id).zoom, 1)
  assert.equal(winOf(b.id).zoom, undefined)
  assert.equal(b.rt.term.options.fontSize, s.getPrefs().font.size)
})

test('the zoom stops at the font bounds instead of building up', () => {
  const { id, rt } = open()
  for (let i = 0; i < 60; i++) wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.equal(rt.term.options.fontSize, 32)
  const top = winOf(id).zoom
  wheel(rt.holder, { ctrlKey: true, deltaY: 100 })
  assert.equal(winOf(id).zoom, top - 1, 'one notch back already shrinks it')
  for (let i = 0; i < 60; i++) wheel(rt.holder, { ctrlKey: true, deltaY: 100 })
  assert.equal(rt.term.options.fontSize, 8)
})

test('a zoom starts from the size the terminal shows now, not from the Aa size', () => {
  const { id, rt } = open()
  rt.term.options.fontSize = 12 // what shrink-to-fit made of a narrow window
  wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.equal(rt.term.options.fontSize, 13)
  assert.equal(winOf(id).zoom, 13 - s.getPrefs().font.size)
})

test('the grid is refitted once, after the zooming settles', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { id, rt } = open()
  let refits = 0
  const refit = () => refits++
  for (let i = 0; i < 5; i++) s.zoomBy(id, 1, refit)
  assert.equal(refits, 0, 'not while the wheel is still turning')
  mock.timers.tick(s.ZOOM_REFIT_MS - 1)
  assert.equal(refits, 0)
  s.zoomBy(id, 1, refit) // another step restarts the wait
  mock.timers.tick(s.ZOOM_REFIT_MS - 1)
  assert.equal(refits, 0)
  mock.timers.tick(1)
  assert.equal(refits, 1)
  mock.timers.tick(10 * s.ZOOM_REFIT_MS)
  assert.equal(refits, 1, 'only once')
  assert.equal(rt.term.options.fontSize, s.getPrefs().font.size + 6)
})

test('a terminal closed during the wait is not refitted', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { id } = open()
  let refits = 0
  s.zoomBy(id, 1, () => refits++)
  s.closeWin(id)
  mock.timers.tick(s.ZOOM_REFIT_MS * 2)
  assert.equal(refits, 0)
})

test('the real refit runs after a wheel zoom (and tolerates a terminal that is not on the page)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { rt } = open()
  wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.doesNotThrow(() => mock.timers.tick(s.ZOOM_REFIT_MS))
})

test('Ctrl+0 goes back to the Aa size; the key is a registry shortcut that the terminal claims', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { id, rt } = open()
  wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  assert.equal(winOf(id).zoom, 2)
  const handler = rt.term._core._customKeyEventHandler
  const ev = new window.KeyboardEvent('keydown', { key: '0', code: 'Digit0', ctrlKey: true, bubbles: true, cancelable: true })
  assert.equal(handler(ev), false, 'xterm does not type it')
  assert.equal(ev.defaultPrevented, true)
  assert.equal(winOf(id).zoom, undefined)
  assert.equal(rt.term.options.fontSize, s.getPrefs().font.size)
  assert.equal(s.formatShortcut(s.SHORTCUTS.find((x) => x.id === 'font-reset'), false), 'Ctrl+0')
  assert.ok(s.SHORTCUTS.some((x) => x.id === 'font-zoom' && x.keys === 'Ctrl+wheel'), 'the wheel is listed in the help')
})

test('Ctrl+wheel is ignored in the overview (the terminals are only scaled there)', () => {
  const { id, rt } = open()
  s.enterOverview(null)
  try {
    const event = wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
    assert.equal(event.defaultPrevented, true, 'still no page zoom')
    assert.equal(winOf(id).zoom, undefined)
  } finally {
    s.exitOverview()
  }
})

test('a new runtime starts at the zoomed size', () => {
  const id = s.openTerminal({ cwd: 'C:\\work' })
  s.updateWin(id, { zoom: 5 })
  const rt = s.ensureRuntime(winOf(id))
  assert.equal(rt.term.options.fontSize, s.getPrefs().font.size + 5)
})

test('the zoom is saved with the terminal and checked on load', async () => {
  const { id, rt } = open()
  wheel(rt.holder, { ctrlKey: true, deltaY: -100 })
  const deadline = Date.now() + 10_000
  const saved = () => JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? '{"wins":[]}').wins.find((w) => w.id === id)
  while (saved()?.zoom !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(saved().zoom, 1)

  const f = await loadStore({ fresh: true })
  const base = { x: 0, y: 0, w: 0.5, h: 0.5, shell: 'default', cwd: '', title: 't', z: 1 }
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({
    wins: [{ ...base, id: 'ok', zoom: 4 }, { ...base, id: 'none' }, { ...base, id: 'str', zoom: '4' }, { ...base, id: 'huge', zoom: 1e9 }, { ...base, id: 'nan', zoom: null }, { ...base, id: 'zero', zoom: 0 }],
    zTop: 6,
  }))
  f.hydrate()
  const zoomOf = (wid) => f.getWins().find((w) => w.id === wid).zoom
  assert.equal(zoomOf('ok'), 4)
  assert.equal(zoomOf('none'), undefined)
  assert.equal(zoomOf('str'), undefined)
  assert.equal(zoomOf('huge'), 24)
  assert.equal(zoomOf('nan'), undefined)
  assert.equal(zoomOf('zero'), 0)
  f.closeAll()
  quiesceStores()
})
