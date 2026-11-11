// Placement edge cases and speed (src/client/placement.ts): many windows, windows partly off the canvas,
// minimized and damaged rects, a small canvas, the cascade fallback, rects from saved layouts.
//
//   node --test tests/placement-edges.test.mjs

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
  s.noteStageSize(0, 0)
})

const inside = (r) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const rectOf = (w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })

/** The original brute-force search (four nested loops over every edge pair): the reference the faster one must agree with. */
function referenceGap(occupied, want, min) {
  const eps = 1e-9
  const PAD = 0.004
  const xs = new Set([0, 1])
  const ys = new Set([0, 1])
  for (const r of occupied) {
    for (const x of [r.x, r.x + r.w]) if (x > 0 && x < 1) xs.add(x)
    for (const y of [r.y, r.y + r.h]) if (y > 0 && y < 1) ys.add(y)
  }
  const sx = [...xs].sort((a, b) => a - b)
  const sy = [...ys].sort((a, b) => a - b)
  const free = (x1, y1, x2, y2) => occupied.every((r) => r.x + r.w <= x1 + eps || r.x >= x2 - eps || r.y + r.h <= y1 + eps || r.y >= y2 - eps)
  let bestScore
  for (let i = 0; i < sx.length; i++) {
    for (let j = i + 1; j < sx.length; j++) {
      const gw = sx[j] - sx[i] - PAD * 2
      if (gw < min.w - eps) continue
      for (let k = 0; k < sy.length; k++) {
        for (let l = k + 1; l < sy.length; l++) {
          const gh = sy[l] - sy[k] - PAD * 2
          if (gh < min.h - eps || !free(sx[i], sy[k], sx[j], sy[l])) continue
          const score = Math.min(gw, want.w) * Math.min(gh, want.h)
          if (bestScore === undefined || score > bestScore) bestScore = score
        }
      }
    }
  }
  return bestScore
}

/** A small deterministic generator, so a failing layout can be reproduced. */
function rng(seed) {
  let x = seed
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296
    return x / 4294967296
  }
}

test('the faster search finds a gap as good as the brute-force one on random layouts', () => {
  const rand = rng(7)
  for (let round = 0; round < 150; round++) {
    const n = Math.floor(rand() * 7)
    const occ = []
    for (let i = 0; i < n; i++) {
      const w = 0.1 + rand() * 0.6
      const h = 0.1 + rand() * 0.6
      occ.push({ x: rand() * (1.1 - w) - 0.1, y: rand() * (1 - h), w, h })
    }
    const got = s.findGap(occ, s.DEFAULT_SIZE, s.MIN_PLACED)
    const ref = referenceGap(occ, s.DEFAULT_SIZE, s.MIN_PLACED)
    assert.equal(got === undefined, ref === undefined, `round ${round}: both find a gap or neither does`)
    if (got === undefined) continue
    assert.ok(Math.abs(got.w * got.h - ref) < 1e-7, `round ${round}: same best area`)
    assert.ok(occ.every((o) => !overlaps(got, o)) && inside(got), `round ${round}: free and inside`)
  }
})

test('40 windows: a gap is found quickly and does not overlap any of them', () => {
  const rand = rng(99)
  const occ = []
  // Five rows of six small windows leave the bottom quarter, and ten more overlap them: a crowded canvas.
  for (let c = 0; c < 6; c++) for (let r = 0; r < 5; r++) occ.push({ x: c / 6, y: r * 0.15, w: 1 / 6 - 0.002, h: 0.148 })
  for (let i = 0; i < 10; i++) occ.push({ x: rand() * 0.8, y: rand() * 0.6, w: 0.15, h: 0.15 })
  assert.equal(occ.length, 40)
  const started = performance.now()
  const gap = s.findGap(occ, s.DEFAULT_SIZE, s.MIN_PLACED)
  const took = performance.now() - started
  assert.ok(took < 100, `took ${took.toFixed(1)} ms`)
  assert.ok(gap !== undefined && occ.every((o) => !overlaps(gap, o)) && inside(gap), 'the bottom quarter is free')
  const full = [...occ, { x: 0, y: 0.74, w: 1, h: 0.26 }]
  const again = performance.now()
  s.findGap(full, s.DEFAULT_SIZE, s.MIN_PLACED)
  assert.ok(performance.now() - again < 100, 'no gap at all is just as fast')
})

test('100 windows still search in a fraction of a second', () => {
  const rand = rng(5)
  const occ = Array.from({ length: 100 }, () => ({ x: rand() * 0.9, y: rand() * 0.9, w: 0.05 + rand() * 0.1, h: 0.05 + rand() * 0.1 }))
  const started = performance.now()
  s.findGap(occ, s.DEFAULT_SIZE, s.MIN_PLACED)
  assert.ok(performance.now() - started < 400)
})

test('windows partly off the canvas only block the part that shows', () => {
  const gap = s.findGap([{ x: -0.3, y: 0, w: 0.5, h: 1 }]) // shows 0..0.2
  assert.ok(gap.x >= 0.2 && gap.w >= s.MIN_PLACED.w && inside(gap))
  const g2 = s.findGap([{ x: 0.8, y: 0, w: 0.5, h: 1 }]) // shows 0.8..1
  assert.ok(g2.x + g2.w <= 0.8 + 1e-9 && inside(g2))
  const g3 = s.findGap([{ x: 0, y: 0.9, w: 1, h: 0.5 }])
  assert.ok(g3.y + g3.h <= 0.9 + 1e-9)
})

test('damaged rects (NaN, zero size) are ignored, not allowed to block the canvas', () => {
  const wins = [
    { x: NaN, y: 0, w: 1, h: 1, minimized: false, maximized: false },
    { x: 0, y: 0, w: 0, h: 1, minimized: false, maximized: false },
    { x: 0, y: 0, w: 0.3, h: 0.3, minimized: false, maximized: false },
  ]
  assert.deepEqual(s.occupiedRects(wins), [{ x: 0, y: 0, w: 0.3, h: 0.3 }])
  assert.ok(Number.isFinite(s.findGap(s.occupiedRects(wins)).x))
})

test('a maximized window without a saved restore rect fills the canvas', () => {
  const id = s.openTerminal({ startup: '', rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } })
  s.updateWin(id, { maximized: true, x: 0, y: 0, w: 1, h: 1, restore: undefined })
  const n = s.openTerminal({ startup: '' })
  const r = rectOf(s.store.wins.find((x) => x.id === n))
  assert.ok(Math.abs(r.x - 0.075) < 1e-9 && Math.abs(r.y - 0.075) < 1e-9 && r.w === 0.5 && r.h === 0.55, 'no gap: the cascade')
})

test('every window minimized: the whole canvas is free again', () => {
  const ids = [0, 1, 2].map((i) => s.openTerminal({ startup: '', rect: { x: i * 0.3, y: 0, w: 0.3, h: 1 } }))
  for (const id of ids) s.updateWin(id, { minimized: true })
  const n = s.openTerminal({ startup: '' })
  const w = s.store.wins.find((x) => x.id === n)
  assert.ok(w.x < 0.01 && w.y < 0.01 && Math.abs(w.w - 0.5) < 1e-9)
})

test('a small canvas: the new window is never smaller than the resize minimum', () => {
  s.noteStageSize(320, 220)
  const empty = s.placeNew([])
  assert.ok(empty.w * 320 >= 240 - 1e-6 && empty.h * 220 >= 130 - 1e-6, 'the default size is raised to the minimum in pixels')
  assert.ok(inside(empty))
  const next = s.placeNew([{ x: 0, y: 0, w: 0.6, h: 1 }])
  assert.ok(next.w * 320 >= 240 - 1e-6 && inside(next), 'no gap of that size: the cascade, still inside and big enough')
  s.noteStageSize(150, 90) // smaller than the minimum itself: take all of it rather than leave the canvas
  const tiny = s.placeNew([])
  assert.ok(inside(tiny) && tiny.w > 0.98 && tiny.h > 0.98)
})

test('without a known canvas size the fractions decide, as before', () => {
  assert.deepEqual(s.placementSizes(), { want: s.DEFAULT_SIZE, min: s.MIN_PLACED })
})

test('the cascade skips a spot where a window of that size already sits', () => {
  assert.deepEqual(s.cascadeRect([]), { x: 0.04, y: 0.04, w: 0.5, h: 0.55 })
  // Eight windows open: the first spot and steps 2-8 are taken, one window sits elsewhere. The ninth would wrap to the first spot.
  const at = (n) => ({ x: 0.04 + n * 0.035, y: 0.04 + n * 0.035, w: 0.5, h: 0.55 })
  const placed = [at(0), ...[2, 3, 4, 5, 6, 7].map(at), { x: 0, y: 0.9, w: 0.2, h: 0.1 }]
  assert.equal(placed.length, 8)
  const ninth = s.cascadeRect(placed)
  assert.ok(Math.abs(ninth.x - at(1).x) < 1e-9, 'the free step was taken, not the one under an existing window')
  assert.ok(inside(ninth))
})

test('the cascade stays inside the canvas whatever the window size', () => {
  for (const want of [{ w: 0.5, h: 0.55 }, { w: 0.98, h: 0.98 }, { w: 1, h: 1 }]) {
    const placed = []
    for (let n = 0; n < 12; n++) {
      const r = s.cascadeRect(placed, want)
      assert.ok(inside(r), `n=${n} ${JSON.stringify(want)}`)
      placed.push(r)
    }
  }
})

test('a rect from a saved layout is kept reachable', () => {
  assert.deepEqual(s.reachableRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
  const off = s.reachableRect({ x: 7, y: -3, w: 0, h: 50 })
  assert.ok(off.x <= 0.9 && off.y >= 0 && off.w >= 0.05 && off.h <= 1)
  const nan = s.reachableRect({ x: NaN, y: NaN, w: NaN, h: NaN })
  assert.ok([nan.x, nan.y, nan.w, nan.h].every(Number.isFinite))
  assert.equal(s.reachableRect({ x: -0.3, y: 0, w: 0.5, h: 0.5 }).x, -0.3, 'partly off-screen is allowed while a grip shows')
  const gone = s.reachableRect({ x: -2, y: 0, w: 0.5, h: 0.5 })
  assert.ok(gone.x + gone.w >= 0.1 - 1e-9)
})

test('openTerminal does not trust a layout rect that sits off the canvas', () => {
  const n = s.openTerminal({ startup: '', rect: { x: 5, y: 5, w: 0.4, h: 0.4 } })
  const w = s.store.wins.find((x) => x.id === n)
  assert.ok(w.x <= 0.9 && w.y <= 0.95)
})
