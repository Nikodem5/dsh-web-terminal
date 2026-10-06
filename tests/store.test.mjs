// Unit tests for the client store's window, layout and preference logic.
//
// The store is TypeScript that imports xterm, so it is bundled with esbuild into
// memory and loaded under jsdom globals. These tests pin behaviour that the
// store refactor must preserve; they use only the store's exported API.
//
//   npm test   (or: node --test tests/*.test.mjs)

import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { JSDOM } = createRequire(import.meta.url)('jsdom')

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1:19387/', pretendToBeVisual: true })
const { window } = dom
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
window.HTMLCanvasElement.prototype.getContext = () => null
window.fetch = () => Promise.resolve({ ok: false })
const WebSocketStub = class { static OPEN = 1 }
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  localStorage: window.localStorage,
  navigator: window.navigator,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  WebSocket: WebSocketStub,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

let s // the loaded store module

before(async () => {
  const result = await build({
    entryPoints: [join(root, 'src', 'client', 'terminal-store.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: 'store.mjs',
    write: false,
    logLevel: 'silent',
  })
  // Imported from memory: no file is written anywhere.
  const code = result.outputFiles[0].text
  s = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
})

beforeEach(() => {
  s.closeAll()
  s.setBroadcast({ on: false })
  window.localStorage.clear()
})

const wins = () => s.getWins()
const byId = (id) => wins().find((w) => w.id === id)

// ── names ──

test('baseName takes the last path segment for either separator', () => {
  assert.equal(s.baseName('C:\\work\\repo'), 'repo')
  assert.equal(s.baseName('/home/me/repo/'), 'repo')
  assert.equal(s.baseName('repo'), 'repo')
})

test('cleanTitle turns a Claude session title into a window name', () => {
  assert.equal(s.cleanTitle('✳ Fix login bug', 'C:\\work\\repo'), 'Fix login bug')
  assert.equal(s.cleanTitle('⠋ Fix login bug', 'C:\\work\\repo'), 'Fix login bug')
})

test('cleanTitle names a bare "Claude Code" after the folder', () => {
  assert.equal(s.cleanTitle('✳ Claude Code', 'C:\\work\\repo'), 'Claude · repo')
  assert.equal(s.cleanTitle('Claude Code', ''), 'Claude')
})

test('cleanTitle rejects shell banners and paths', () => {
  for (const raw of ['', '   ', 'C:\\Windows\\system32\\cmd.exe', 'Windows PowerShell', 'Administrator: cmd', 'bash']) {
    assert.equal(s.cleanTitle(raw, 'C:\\x'), undefined, `should reject ${JSON.stringify(raw)}`)
  }
})

// Known bug: the leading-symbol strip (meant for Claude's status glyph) also eats the
// "/" or "~" that the path check looks for, so a POSIX path title becomes a window name.
test('cleanTitle rejects POSIX paths', { todo: 'bug: leading "/" and "~" are stripped before the path check' }, () => {
  for (const raw of ['/usr/bin/bash', '~/code']) {
    assert.equal(s.cleanTitle(raw, '/x'), undefined, `should reject ${JSON.stringify(raw)}`)
  }
})

// Known bug: the banner pattern is `MINGW\b`, which does not match "MINGW64" (Git Bash's title).
test('cleanTitle rejects the Git Bash title', { todo: 'bug: "MINGW64:/c/x" is not recognised as a shell banner' }, () => {
  assert.equal(s.cleanTitle('MINGW64:/c/Users/me', '/x'), undefined)
})

test('cleanTitle truncates long titles', () => {
  const name = s.cleanTitle('a'.repeat(100), '')
  assert.equal(name.length, 60)
  assert.ok(name.endsWith('…'))
})

// ── opening, naming, ordering ──

test('openTerminal puts the newest window first, focused, and on top', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  assert.deepEqual(wins().map((w) => w.id), [b, a])
  assert.equal(s.getFocusId(), b)
  assert.ok(byId(b).z > byId(a).z)
})

test('openTerminal defaults: numbered title, auto-named, cascaded geometry', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  assert.equal(byId(a).title, 'Terminal 1')
  assert.equal(byId(a).nameManual, false)
  assert.equal(byId(b).title, 'Terminal 2')
  assert.ok(byId(b).x > byId(a).x && byId(b).y > byId(a).y)
})

test('an explicit title makes the name manual; duplicate keeps shell, folder and startup', () => {
  const a = s.openTerminal({ cwd: 'C:\\a', shell: 'cmd', startup: 'claude', title: 'Agent A' })
  assert.equal(byId(a).nameManual, true)
  s.duplicateWin(a)
  const copy = wins()[0]
  assert.notEqual(copy.id, a)
  assert.equal(copy.title, 'Agent A copy')
  assert.equal(copy.shell, 'cmd')
  assert.equal(copy.cwd, 'C:\\a')
  assert.equal(copy.startup, 'claude')
})

test('renaming pins the name; an empty name returns to automatic', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  s.renameWin(a, '  Build  ')
  assert.equal(byId(a).title, 'Build')
  assert.equal(byId(a).nameManual, true)
  assert.equal(s.displayName(byId(a)), 'Build')
  s.renameWin(a, '   ')
  assert.equal(byId(a).nameManual, false)
})

test('displayName falls back to autoName when not manual', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  s.updateWin(a, { autoName: 'Fix login bug' })
  assert.equal(s.displayName(byId(a)), 'Fix login bug')
})

test('moveWin reorders the list, before a target or to the end', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  const c = s.openTerminal({ cwd: 'C:\\c' })
  assert.deepEqual(wins().map((w) => w.id), [c, b, a])
  s.moveWin(a, c)
  assert.deepEqual(wins().map((w) => w.id), [a, c, b])
  s.moveWin(a, null)
  assert.deepEqual(wins().map((w) => w.id), [c, b, a])
})

test('cycleFocus walks the list order and wraps', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  const c = s.openTerminal({ cwd: 'C:\\c' })
  assert.equal(s.getFocusId(), c)
  s.cycleFocus(1)
  assert.equal(s.getFocusId(), b)
  s.cycleFocus(1)
  assert.equal(s.getFocusId(), a)
  s.cycleFocus(1)
  assert.equal(s.getFocusId(), c)
  s.cycleFocus(-1)
  assert.equal(s.getFocusId(), a)
})

test('focusWin raises the window above the others and un-minimizes it', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  s.updateWin(a, { minimized: true })
  s.focusWin(a)
  assert.equal(byId(a).minimized, false)
  assert.ok(byId(a).z > byId(b).z)
  assert.equal(s.getFocusId(), a)
})

test('z-order stays bounded however many times focus changes', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  for (let i = 0; i < 6000; i++) s.focusWin(i % 2 === 0 ? a : b)
  assert.ok(Math.max(...wins().map((w) => w.z)) < 5000)
})

// ── maximize, close ──

test('maximize fills the canvas and restore returns the old geometry', () => {
  const a = s.openTerminal({ cwd: 'C:\\a', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })
  s.toggleMaximize(a)
  assert.deepEqual([byId(a).x, byId(a).y, byId(a).w, byId(a).h], [0, 0, 1, 1])
  assert.equal(byId(a).maximized, true)
  s.toggleMaximize(a)
  assert.deepEqual([byId(a).x, byId(a).y, byId(a).w, byId(a).h], [0.1, 0.2, 0.3, 0.4])
  assert.equal(byId(a).maximized, false)
})

test('a pinned window cannot be maximized', () => {
  const a = s.openTerminal({ cwd: 'C:\\a', pinned: true })
  s.toggleMaximize(a)
  assert.equal(byId(a).maximized, false)
})

test('closeWin removes the window and clears focus and broadcast membership', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  s.setBroadcast({ on: true })
  assert.ok(s.getBroadcast().ids.has(b))
  s.closeWin(b)
  assert.deepEqual(wins().map((w) => w.id), [a])
  assert.equal(s.getFocusId(), null)
  assert.ok(!s.getBroadcast().ids.has(b))
})

test('closeAll empties the workspace', () => {
  s.openTerminal({ cwd: 'C:\\a' })
  s.openTerminal({ cwd: 'C:\\b' })
  s.closeAll()
  assert.equal(wins().length, 0)
  assert.equal(s.getFocusId(), null)
})

// ── layout presets ──

const geometry = (id) => {
  const w = byId(id)
  return { x: w.x, y: w.y, w: w.w, h: w.h }
}
const overlaps = (p, q) => p.x < q.x + q.w - 1e-9 && q.x < p.x + p.w - 1e-9 && p.y < q.y + q.h - 1e-9 && q.y < p.y + p.h - 1e-9

test('grid, columns, rows and main-side tile without overlap and stay inside the canvas', () => {
  for (const preset of ['grid', 'columns', 'rows', 'main-side']) {
    for (const n of [1, 2, 3, 4, 5]) {
      s.closeAll()
      const ids = Array.from({ length: n }, (_, i) => s.openTerminal({ cwd: `C:\\${i}` }))
      s.arrange(preset)
      const rects = ids.map(geometry)
      for (const r of rects) {
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, `${preset}/${n} stays in canvas`)
      }
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(!overlaps(rects[i], rects[j]), `${preset}/${n} windows ${i},${j} overlap`)
    }
  }
})

test('arrange leaves pinned and minimized windows alone', () => {
  const pinned = s.openTerminal({ cwd: 'C:\\a', pinned: true, rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } })
  const hidden = s.openTerminal({ cwd: 'C:\\b', minimized: true, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })
  const free = s.openTerminal({ cwd: 'C:\\c' })
  s.arrange('grid')
  assert.deepEqual(geometry(pinned), { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
  assert.deepEqual(geometry(hidden), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })
  assert.ok(geometry(free).w > 0.9)
})

test('arrange un-maximizes the windows it moves', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  s.toggleMaximize(a)
  s.arrange('columns')
  assert.equal(byId(a).maximized, false)
})

// ── busy detection used by safe close ──

test('busyAmong ignores terminals with no live runtime', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  assert.deepEqual(s.busyAmong([a]), [])
})

// ── folders, favourites, preferences ──

test('noteFolder keeps recents unique, newest first, capped at 12', () => {
  for (let i = 0; i < 15; i++) s.noteFolder(`C:\\f${i}`)
  s.noteFolder('C:\\f10')
  const { recents, lastCwd } = s.getPrefs()
  assert.equal(recents.length, 12)
  assert.equal(recents[0], 'C:\\f10')
  assert.equal(new Set(recents).size, 12)
  assert.equal(lastCwd, 'C:\\f10')
})

test('toggleFavourite adds then removes; forgetRecent drops one entry', () => {
  s.toggleFavourite('C:\\fav')
  assert.ok(s.getPrefs().favourites.includes('C:\\fav'))
  s.toggleFavourite('C:\\fav')
  assert.ok(!s.getPrefs().favourites.includes('C:\\fav'))
  s.noteFolder('C:\\gone')
  s.forgetRecent('C:\\gone')
  assert.ok(!s.getPrefs().recents.includes('C:\\gone'))
})

test('setFont clamps size and line height and falls back for an empty family', () => {
  s.setFont({ size: 500, lineHeight: 9, family: '   ' })
  const { font, fontCustom } = s.getPrefs()
  assert.equal(font.size, 32)
  assert.equal(font.lineHeight, 2)
  assert.equal(font.family, s.DEFAULT_FONT.family)
  assert.equal(fontCustom, true)
  s.setFont({ size: 1 })
  assert.equal(s.getPrefs().font.size, 8)
})

test('setFitCols clamps to a sane column range', () => {
  s.setFitCols(5)
  assert.equal(s.getPrefs().fitCols, 40)
  s.setFitCols(9999)
  assert.equal(s.getPrefs().fitCols, 240)
})

// ── saved layouts ──

test('saveLayout snapshots the windows; loadLayout reopens them with their geometry', () => {
  s.openTerminal({ cwd: 'C:\\a', shell: 'cmd', startup: 'claude', title: 'Agent A', rect: { x: 0, y: 0, w: 0.5, h: 1 }, pinned: true })
  s.openTerminal({ cwd: 'C:\\b', title: 'Agent B', rect: { x: 0.5, y: 0, w: 0.5, h: 1 } })
  s.saveLayout('pair')
  s.closeAll()
  s.loadLayout('pair')
  const loaded = wins()
  assert.equal(loaded.length, 2)
  const a = loaded.find((w) => w.title === 'Agent A')
  assert.equal(a.cwd, 'C:\\a')
  assert.equal(a.shell, 'cmd')
  assert.equal(a.startup, 'claude')
  assert.equal(a.pinned, true)
  assert.deepEqual([a.x, a.w, a.h], [0, 0.5, 1])
})

test('saving a layout under an existing name replaces it; empty workspace saves nothing', () => {
  s.saveLayout('empty')
  assert.ok(!s.getPrefs().layouts.some((l) => l.name === 'empty'))
  s.openTerminal({ cwd: 'C:\\a' })
  s.saveLayout('x')
  s.openTerminal({ cwd: 'C:\\b' })
  s.saveLayout('x')
  const layouts = s.getPrefs().layouts.filter((l) => l.name === 'x')
  assert.equal(layouts.length, 1)
  assert.equal(layouts[0].wins.length, 2)
  s.deleteLayout('x')
  assert.ok(!s.getPrefs().layouts.some((l) => l.name === 'x'))
})

test('a maximized window is saved with its restore geometry, not full-screen', () => {
  const a = s.openTerminal({ cwd: 'C:\\a', rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } })
  s.toggleMaximize(a)
  s.saveLayout('max')
  const saved = s.getPrefs().layouts.find((l) => l.name === 'max').wins[0]
  assert.deepEqual([saved.x, saved.y, saved.w, saved.h], [0.1, 0.1, 0.3, 0.3])
})

// ── broadcast ──

test('turning broadcast on selects every window; targets can be toggled and set', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  s.setBroadcast({ on: true })
  assert.deepEqual([...s.getBroadcast().ids].sort(), [a, b].sort())
  s.toggleBroadcastTarget(a)
  assert.ok(!s.getBroadcast().ids.has(a))
  s.setBroadcastTargets([a])
  assert.deepEqual([...s.getBroadcast().ids], [a])
})

test('broadcastLine reports zero when no terminal has an open socket', () => {
  s.openTerminal({ cwd: 'C:\\a' })
  s.setBroadcast({ on: true })
  assert.equal(s.broadcastLine('ls'), 0)
})

// ── persistence ──

test('window state is written to localStorage after a short delay', async () => {
  s.openTerminal({ cwd: 'C:\\a', title: 'Persisted' })
  await new Promise((r) => setTimeout(r, 400))
  const saved = JSON.parse(window.localStorage.getItem('dsh.web-terminal.layout.v1'))
  assert.ok(saved.wins.some((w) => w.title === 'Persisted'))
  assert.ok(window.localStorage.getItem('dsh.web-terminal.prefs.v1'))
})

// ── colour measurement ──

test('luminanceOf reads rgb colours and treats transparent as unknown', () => {
  assert.ok(s.luminanceOf('rgb(0, 0, 0)') < 0.01)
  assert.ok(s.luminanceOf('rgb(255, 255, 255)') > 0.99)
  assert.equal(s.luminanceOf('rgba(255, 255, 255, 0.1)'), undefined)
  assert.equal(s.luminanceOf('transparent'), undefined)
})
