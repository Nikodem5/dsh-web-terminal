// Unit tests for mission control's pure parts: grid layout, aspect-preserving scale, filter, selection.

import { test, before, after } from 'node:test'
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

const items = (n, w = 600, h = 300) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, x: 10, y: 20, w, h }))

test('fitInto letterboxes, keeps the aspect ratio and never upscales', () => {
  const wide = s.fitInto({ w: 600, h: 300 }, { x: 100, y: 50, w: 200, h: 200 })
  assert.equal(wide.scale, 1 / 3)
  assert.equal(wide.x, 100)
  assert.equal(wide.y, 50 + (200 - 100) / 2)
  const small = s.fitInto({ w: 100, h: 50 }, { x: 0, y: 0, w: 400, h: 400 })
  assert.equal(small.scale, 1)
  assert.equal(small.x, 150)
})

test('planOverview: one tile fills the stage', () => {
  const p = s.planOverview(items(1), { w: 1000, h: 600 })
  assert.equal(p.cols, 1)
  assert.equal(p.tiles.length, 1)
  assert.ok(p.tiles[0].tile.w > 900 && p.tiles[0].tile.h > 500)
})

test('planOverview: 1..24 terminals fit inside the stage, never overlap, keep the aspect ratio', () => {
  for (const stage of [{ w: 1200, h: 700 }, { w: 500, h: 900 }, { w: 1800, h: 400 }]) {
    for (let n = 1; n <= 24; n++) {
      const p = s.planOverview(items(n), stage)
      assert.equal(p.tiles.length, n)
      assert.ok(p.cols * p.rows >= n && p.cols * (p.rows - 1) < n, `grid shape for ${n}`)
      for (const [i, t] of p.tiles.entries()) {
        assert.ok(t.tile.x >= 0 && t.tile.y >= 0 && t.tile.x + t.tile.w <= stage.w + 1e-6 && t.tile.y + t.tile.h <= stage.h + 1e-6, `tile ${i}/${n} inside`)
        assert.ok(t.scale > 0 && t.scale <= 1)
        // The scaled window lies within its tile.
        const x = 10 + t.tx
        const y = 20 + t.ty
        assert.ok(x >= t.tile.x - 1e-6 && x + 600 * t.scale <= t.tile.x + t.tile.w + 1e-6)
        assert.ok(y >= t.tile.y - 1e-6 && y + 300 * t.scale <= t.tile.y + t.tile.h + 1e-6)
        for (const o of p.tiles.slice(i + 1)) {
          const apart = t.tile.x + t.tile.w <= o.tile.x + 1e-6 || o.tile.x + o.tile.w <= t.tile.x + 1e-6 || t.tile.y + t.tile.h <= o.tile.y + 1e-6 || o.tile.y + o.tile.h <= t.tile.y + 1e-6
          assert.ok(apart, 'tiles do not overlap')
        }
      }
    }
  }
})

test('planOverview: grid columns follow the stage aspect ratio', () => {
  const wide = s.planOverview(items(4), { w: 2000, h: 400 })
  const tall = s.planOverview(items(4), { w: 400, h: 2000 })
  assert.ok(wide.cols > tall.cols)
  assert.equal(s.planOverview(items(9), { w: 1200, h: 800 }).cols, 3)
  assert.equal(s.planOverview([], { w: 100, h: 100 }).tiles.length, 0)
})

test('filterTiles matches name or folder, case-insensitive, every term', () => {
  const list = [{ name: 'Fix login', cwd: 'C:\\work\\api' }, { name: 'Docs', cwd: 'C:\\work\\site' }, { name: 'Claude api', cwd: '/home/me/api' }]
  assert.equal(s.filterTiles(list, '').length, 3)
  assert.deepEqual(s.filterTiles(list, 'LOGIN').map((x) => x.name), ['Fix login'])
  assert.deepEqual(s.filterTiles(list, 'api').map((x) => x.name), ['Fix login', 'Claude api'])
  assert.deepEqual(s.filterTiles(list, 'claude api').map((x) => x.name), ['Claude api'])
  assert.deepEqual(s.filterTiles(list, 'zzz'), [])
})

test('resolveSel and moveSel', () => {
  assert.equal(s.resolveSel(['a', 'b'], 'b'), 'b')
  assert.equal(s.resolveSel(['a', 'b'], 'x'), 'a')
  assert.equal(s.resolveSel([], 'x'), null)
  assert.equal(s.moveSel(6, 3, 0, 'ArrowRight'), 1)
  assert.equal(s.moveSel(6, 3, 0, 'ArrowLeft'), 0)
  assert.equal(s.moveSel(6, 3, 1, 'ArrowDown'), 4)
  assert.equal(s.moveSel(6, 3, 4, 'ArrowDown'), 4)
  assert.equal(s.moveSel(6, 3, 4, 'ArrowUp'), 1)
  assert.equal(s.moveSel(0, 3, 0, 'ArrowUp'), -1)
})

test('Ctrl+Shift+Space is the shortcut', () => {
  const ev = (init) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init })
  assert.equal(s.isMissionShortcut(ev({ ctrlKey: true, shiftKey: true, code: 'Space', key: ' ' })), true)
  assert.equal(s.isMissionShortcut(ev({ ctrlKey: true, code: 'Space', key: ' ' })), false)
})
