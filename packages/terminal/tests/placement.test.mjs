// New terminals fill the largest free gap on the canvas (findGap / occupiedRects in src/client/windows.ts),
// and fall back to the cascade when no gap reaches the minimum size.
//
//   node --test tests/placement.test.mjs

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadStore, window } from './helpers/load-store.mjs'

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
})

const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const rectOf = (w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })

test('empty canvas: default size at the top-left', () => {
  const r = s.findGap([])
  assert.ok(Math.abs(r.w - s.DEFAULT_SIZE.w) < 1e-9 && Math.abs(r.h - s.DEFAULT_SIZE.h) < 1e-9)
  assert.ok(inside(r))
})

test('the gap beside a window is used at the default size when it fits', () => {
  const r = s.findGap([{ x: 0, y: 0, w: 0.4, h: 1 }])
  assert.ok(r.x >= 0.4)
  assert.ok(Math.abs(r.w - 0.5) < 1e-9)
  assert.ok(inside(r))
})

test('a smaller gap shrinks the window down to it', () => {
  const left = { x: 0, y: 0, w: 0.7, h: 1 }
  const r = s.findGap([left])
  assert.ok(r.x >= 0.7 && r.w < 0.3 && r.w >= s.MIN_PLACED.w)
  assert.ok(!overlaps(r, left) && inside(r))
})

test('no gap reaching the minimum gives undefined', () => {
  assert.equal(s.findGap([{ x: 0, y: 0, w: 0.9, h: 1 }]), undefined)
})

test('the new rect never overlaps an occupied one', () => {
  const occ = [{ x: 0, y: 0, w: 0.5, h: 0.55 }, { x: 0.5, y: 0, w: 0.5, h: 0.4 }, { x: 0, y: 0.55, w: 0.3, h: 0.45 }]
  const r = s.findGap(occ)
  assert.ok(occ.every((o) => !overlaps(r, o)) && inside(r))
})

test('openTerminal fills the gap; minimized windows take no space', () => {
  const a = s.openTerminal({ startup: '', rect: { x: 0, y: 0, w: 0.6, h: 1 } })
  const b = s.openTerminal({ startup: '' })
  const wb = s.store.wins.find((w) => w.id === b)
  assert.ok(wb.x >= 0.6 && wb.w >= s.MIN_PLACED.w)
  s.updateWin(a, { minimized: true })
  const c = s.openTerminal({ startup: '' })
  const wc = s.store.wins.find((w) => w.id === c)
  assert.ok(wc.x < 0.1 && Math.abs(wc.w - 0.5) < 1e-9, 'minimized window leaves its space free')
})

test('an explicit rect is used as given', () => {
  const rect = { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }
  s.openTerminal({ startup: '', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } })
  const id = s.openTerminal({ startup: '', rect })
  assert.deepEqual(rectOf(s.store.wins.find((w) => w.id === id)), rect)
})

test('a maximized window counts as the rect it restores to', () => {
  const id = s.openTerminal({ startup: '', rect: { x: 0, y: 0, w: 0.5, h: 1 } })
  s.toggleMaximize(id)
  const n = s.openTerminal({ startup: '' })
  const wn = s.store.wins.find((w) => w.id === n)
  assert.ok(wn.x >= 0.5)
})

test('no gap: falls back to the cascade', () => {
  s.openTerminal({ startup: '', rect: { x: 0, y: 0, w: 1, h: 1 } })
  const id = s.openTerminal({ startup: '' })
  const w = s.store.wins.find((x) => x.id === id)
  assert.deepEqual(rectOf(w), { x: 0.04 + 0.035, y: 0.04 + 0.035, w: 0.5, h: 0.55 })
})

test('the cascade preset is unchanged', () => {
  s.openTerminal({ startup: '' })
  s.openTerminal({ startup: '' })
  s.arrange('cascade')
  const ws = [...s.store.wins]
  ws.forEach((w, i) => assert.deepEqual(rectOf(w), { x: 0.03 + i * 0.035, y: 0.03 + i * 0.045, w: 0.5, h: 0.55 }))
})
