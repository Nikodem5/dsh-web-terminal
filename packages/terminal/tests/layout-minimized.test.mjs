// Saving a layout leaves out minimized terminals; older layouts that hold them still load.
//
//   npm test   (or: node --test tests/layout-minimized.test.mjs)

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadStore, quiesceStores, window } from './helpers/load-store.mjs'

let s

before(async () => {
  s = await loadStore()
})

after(() => {
  s.closeAll()
  window.close()
})

afterEach(() => quiesceStores())

beforeEach(() => {
  s.closeAll()
  s.setBroadcast({ on: false })
  quiesceStores()
})

const saved = (name) => s.getPrefs().layouts.find((l) => l.name === name)

test('saveLayout leaves minimized terminals out of the layout', () => {
  s.openTerminal({ cwd: 'C:\a', title: 'Visible' })
  s.openTerminal({ cwd: 'C:\b', title: 'Hidden', minimized: true })
  s.saveLayout('mix')
  assert.deepEqual(saved('mix').wins.map((w) => w.title), ['Visible'])
})

test('saveLayout saves nothing when every terminal is minimized', () => {
  s.openTerminal({ cwd: 'C:\a', minimized: true })
  s.saveLayout('allmin')
  assert.equal(saved('allmin'), undefined)
})

test('a previously saved layout with a minimized entry still loads it minimized', () => {
  s.getPrefs().layouts.push({
    name: 'old',
    savedAt: 1,
    wins: [
      { title: 'A', cwd: 'C:\a', x: 0, y: 0, w: 0.5, h: 1, pinned: false, minimized: false },
      { title: 'B', cwd: 'C:\b', x: 0.5, y: 0, w: 0.5, h: 1, pinned: false, minimized: true },
    ],
  })
  s.loadLayout('old')
  const wins = s.getWins()
  assert.equal(wins.length, 2)
  assert.equal(wins.find((w) => w.title === 'B').minimized, true)
})
