// Colour tag per terminal (src/client/tag-palette.ts, tags.ts): palette, saving, loading, layouts, duplicate.
//
//   node --test tests/tags.test.mjs

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, quiesceStores, window } from './helpers/load-store.mjs'

const LAYOUT_KEY = 'dsh.web-terminal.layout.v1'
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
  s.getPrefs().layouts.length = 0
  quiesceStores()
})
afterEach(() => quiesceStores())

const winOf = (id) => s.getWins().find((w) => w.id === id)

test('the palette is small, has unique ids and valid colours', () => {
  assert.ok(s.TAG_COLORS.length >= 6 && s.TAG_COLORS.length <= 10)
  assert.equal(new Set(s.TAG_COLORS.map((c) => c.id)).size, s.TAG_COLORS.length)
  for (const c of s.TAG_COLORS) {
    assert.match(c.hex, /^#[0-9a-f]{6}$/)
    assert.ok(c.label.length > 0)
  }
})

test('cleanTag keeps a palette id and nothing else, so a stored value can never become CSS', () => {
  assert.equal(s.cleanTag('blue'), 'blue')
  for (const bad of ['Blue', 'red; background: url(x)', '#ff0000', '', null, undefined, 3, {}, ['red']]) assert.equal(s.cleanTag(bad), undefined, String(bad))
})

test('tagProps: a data-tag and the colour variable for a tagged window, nothing for an untagged one', () => {
  assert.deepEqual(s.tagProps(undefined), {})
  assert.deepEqual(s.tagProps('nope'), {})
  const green = s.TAG_COLORS.find((c) => c.id === 'green')
  assert.deepEqual(s.tagProps('green'), { 'data-tag': 'green', style: { '--wt-tag': green.hex } })
})

test('setWinColor tags a window, changes it and removes it; a bad id removes it too', () => {
  const id = s.openTerminal({ cwd: 'C:\\a' })
  assert.equal(winOf(id).color, undefined)
  s.setWinColor(id, 'red')
  assert.equal(winOf(id).color, 'red')
  s.setWinColor(id, 'purple')
  assert.equal(winOf(id).color, 'purple')
  s.setWinColor(id, 'chartreuse')
  assert.equal(winOf(id).color, undefined)
  s.setWinColor(id, 'teal')
  s.setWinColor(id, undefined)
  assert.equal(winOf(id).color, undefined)
})

test('setWinColor notifies the view', () => {
  const id = s.openTerminal({ cwd: 'C:\\a' })
  const before = s.getVersion()
  s.setWinColor(id, 'pink')
  assert.ok(s.getVersion() > before)
})

test('a new window can open tagged, and a duplicate keeps the tag', () => {
  const id = s.openTerminal({ cwd: 'C:\\a', color: 'orange' })
  assert.equal(winOf(id).color, 'orange')
  assert.equal(winOf(s.openTerminal({ cwd: 'C:\\a', color: 'nonsense' })).color, undefined)
  s.duplicateWin(id)
  const copy = s.getWins().find((w) => w.id !== id && w.title.endsWith('copy'))
  assert.equal(copy.color, 'orange')
})

test('the tag is saved with the window and checked on load', async () => {
  const id = s.openTerminal({ cwd: 'C:\\a' })
  s.setWinColor(id, 'yellow')
  const deadline = Date.now() + 10_000
  const saved = () => JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? '{"wins":[]}').wins.find((w) => w.id === id)
  while (saved()?.color !== 'yellow' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(saved().color, 'yellow')

  const f = await loadStore({ fresh: true })
  const base = { x: 0, y: 0, w: 0.5, h: 0.5, shell: 'default', cwd: '', title: 't', z: 1 }
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({
    wins: [{ ...base, id: 'ok', color: 'teal' }, { ...base, id: 'none' }, { ...base, id: 'css', color: 'red;x:y' }, { ...base, id: 'num', color: 7 }],
    zTop: 4,
  }))
  f.hydrate()
  const colorOf = (wid) => f.getWins().find((w) => w.id === wid).color
  assert.equal(colorOf('ok'), 'teal')
  assert.equal(colorOf('none'), undefined)
  assert.equal(colorOf('css'), undefined)
  assert.equal(colorOf('num'), undefined)
  f.closeAll()
  quiesceStores()
})

test('saved layouts keep each window\'s tag and reopen with it', () => {
  const a = s.openTerminal({ cwd: 'C:\\a', rect: { x: 0, y: 0, w: 0.4, h: 0.5 }, title: 'A', nameManual: true })
  s.openTerminal({ cwd: 'C:\\b', rect: { x: 0.5, y: 0, w: 0.4, h: 0.5 }, title: 'B', nameManual: true })
  s.setWinColor(a, 'blue')
  s.saveLayout('tagged')
  const layout = s.getPrefs().layouts.find((l) => l.name === 'tagged')
  assert.deepEqual(layout.wins.map((w) => [w.title, w.color]).sort(), [['A', 'blue'], ['B', undefined]])
  s.closeAll()
  s.loadLayout('tagged')
  const byTitle = (t) => s.getWins().find((w) => w.title === t)
  assert.equal(byTitle('A').color, 'blue')
  assert.equal(byTitle('B').color, undefined)
})

test('a saved layout is checked on load: a bad tag in it is dropped, the window stays', async () => {
  const f = await loadStore({ fresh: true })
  const w = { title: 'x', shell: 'default', cwd: '', x: 0, y: 0, w: 0.5, h: 0.5, pinned: false, minimized: false }
  window.localStorage.setItem(PREFS_KEY, JSON.stringify({ layouts: [{ name: 'l', savedAt: 1, wins: [{ ...w, color: 'green' }, { ...w, color: 'not-a-colour' }, { ...w }] }] }))
  f.hydrate()
  assert.deepEqual(f.getPrefs().layouts[0].wins.map((x) => x.color), ['green', undefined, undefined])
  f.closeAll()
  quiesceStores()
})
