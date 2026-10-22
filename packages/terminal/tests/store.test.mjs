// Unit tests for the client store's window, layout and preference logic.
//
// The store is TypeScript that imports xterm, so it is bundled with esbuild into
// memory and loaded under jsdom globals. These tests pin behaviour that the
// store refactor must preserve; they use only the store's exported API.
//
//   npm test   (or: node --test tests/*.test.mjs)

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadStore, quiesceStores, window } from './helpers/load-store.mjs'

let s // the loaded store module

before(async () => {
  s = await loadStore()
})

after(() => {
  // Let the process exit: stop the runtime ticker and jsdom's timers.
  s.closeAll()
  window.close()
})

afterEach(() => quiesceStores())

beforeEach(() => {
  s.closeAll()
  s.setBroadcast({ on: false })
  quiesceStores() // closeAll above scheduled a save: it must not land after a test seeds storage
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

test('cleanTitle rejects banners and paths real shells set', () => {
  const rejected = [
    '/usr/bin/bash', '~/code', '~', '/', '\\\\server\\share', 'C:\\Users\\me', 'C:/Users/me',
    'MINGW64:/c/Users/me', 'MINGW32', 'MSYS', 'user@host: ~/projects', 'user@host:/var/log', 'me@box',
    'Windows PowerShell', 'PowerShell 7', 'PowerShell 7.4.1', 'pwsh', 'cmd', 'Command Prompt', 'Administrator: Windows PowerShell',
    'wsl', 'Ubuntu', 'zsh', 'bash', 'fish', 'bash: ~/x', '✳ ~/code', 'x', // last: bare directory name == cwd folder
  ]
  for (const raw of rejected) {
    assert.equal(s.cleanTitle(raw, '/home/me/x'), undefined, `should reject ${JSON.stringify(raw)}`)
  }
})

test('cleanTitle keeps real program titles', () => {
  const accepted = [
    ['Fix login bug', 'Fix login bug'], ['✳ Fix login bug', 'Fix login bug'], ['vim main.ts', 'vim main.ts'],
    ['npm run dev', 'npm run dev'], ['sh deploy.sh', 'sh deploy.sh'], ['ssh me@host', 'ssh me@host'],
    ['bashing the build', 'bashing the build'], ['Ubuntu setup notes', 'Ubuntu setup notes'], ['cmd-k palette', 'cmd-k palette'],
  ]
  for (const [raw, want] of accepted) {
    assert.equal(s.cleanTitle(raw, '/home/me/x'), want, `should accept ${JSON.stringify(raw)}`)
  }
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

test('cycleFocus skips minimized windows', () => {
  const a = s.openTerminal({ cwd: 'C:\\a' })
  const b = s.openTerminal({ cwd: 'C:\\b' })
  const c = s.openTerminal({ cwd: 'C:\\c' })
  s.updateWin(b, { minimized: true })
  s.cycleFocus(1)
  assert.equal(s.getFocusId(), a)
  s.cycleFocus(-1)
  assert.equal(s.getFocusId(), c)
  s.updateWin(c, { minimized: true })
  s.cycleFocus(1)
  assert.equal(s.getFocusId(), a)
})

test('clearFocus leaves no terminal focused', () => {
  s.openTerminal({ cwd: 'C:\\a' })
  s.clearFocus()
  assert.equal(s.getFocusId(), null)
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

test('readability defaults: bigger font, mono-first family, 1.2 line height, semi-bold, 4.5:1 contrast', () => {
  const d = s.DEFAULT_FONT
  assert.equal(d.size, 14)
  assert.equal(d.lineHeight, 1.2)
  assert.equal(d.letterSpacing, 0)
  assert.equal(d.boldWeight, 600)
  assert.equal(d.minContrast, 4.5)
  assert.ok(d.family.startsWith("'Cascadia Mono'") && d.family.endsWith('monospace'))
})

test('setFont clamps letter spacing, bold weight and contrast', () => {
  s.setFont({ letterSpacing: 9, boldWeight: 5000, minContrast: 99 })
  assert.deepEqual([s.getPrefs().font.letterSpacing, s.getPrefs().font.boldWeight, s.getPrefs().font.minContrast], [2, 900, 21])
  s.setFont({ letterSpacing: -3, boldWeight: 20, minContrast: 0.2 })
  assert.deepEqual([s.getPrefs().font.letterSpacing, s.getPrefs().font.boldWeight, s.getPrefs().font.minContrast], [0, 100, 1])
})

test('auto-fit never shrinks below the floor on a normal window, and honours letter spacing', () => {
  s.setAutoFont(true)
  s.setFitCols(100)
  s.setFont({ ...s.DEFAULT_FONT })
  assert.equal(s.effectiveFontSize(2000), 14, 'wide window keeps the full size')
  assert.equal(s.effectiveFontSize(720), 12, '720px = 100 cols at 12px')
  assert.equal(s.effectiveFontSize(300), s.AUTO_FONT_FLOOR, 'very narrow window stops at the floor')
  assert.ok(s.effectiveFontSize(900) >= 13, 'a 900px window stays at 13 or more')
  s.setFont({ letterSpacing: 2 })
  assert.ok(s.effectiveFontSize(900) <= 13, 'letter spacing makes cells wider, so the font shrinks sooner')
})

// ── palette contrast ──

test('contrastRatio matches known WCAG values', () => {
  assert.equal(Math.round(s.contrastRatio('#000000', '#ffffff')), 21)
  assert.equal(s.contrastRatio('#777777', '#777777'), 1)
})

test('palettes: text colours reach 4.5:1 on their background (black excepted), default text far above', () => {
  for (const dark of [true, false]) {
    const p = s.termPalette(dark)
    assert.ok(s.contrastRatio(p.foreground, p.background) >= 12, `${dark ? 'dark' : 'light'} foreground`)
    for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite', 'cursor']) {
      if (name === 'cursor' && !dark) continue
      assert.ok(s.contrastRatio(p[name], p.background) >= 4.5, `${dark ? 'dark' : 'light'} ${name} ${s.contrastRatio(p[name], p.background).toFixed(2)}`)
    }
  }
  // SGR dim text is the default foreground at half opacity: it must still clear 4.5:1.
  const p = s.termPalette(true)
  const half = (c, b) => Math.round((c + b) / 2).toString(16).padStart(2, '0')
  const dim = '#' + [1, 3, 5].map((i) => half(parseInt(p.foreground.slice(i, i + 2), 16), parseInt(p.background.slice(i, i + 2), 16))).join('')
  assert.ok(s.contrastRatio(dim, p.background) >= 4.5, `dim default text ${s.contrastRatio(dim, p.background).toFixed(2)}`)
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
  const deadline = Date.now() + 10_000
  while (window.localStorage.getItem('dsh.web-terminal.layout.v1') === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
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

// ── attention: pure decisions ──

const agent = (state, detail = '') => ({ provider: 'claude', state, detail, since: 0 })
const signal = (state, detail = '') => ({ provider: 'claude', state, detail })

test('deriveActivity: agent signals drive the dot, plain shells show only facts', () => {
  const live = (a, hostBusy) => s.deriveActivity({ conn: 'live', agent: a, hostBusy })
  assert.equal(live(agent('working'), false), 'working')
  assert.equal(live(agent('needs-you'), true), 'needs-you')
  assert.equal(live(agent('failed'), true), 'needs-you')
  assert.equal(live(agent('finished'), true), 'finished')
  assert.equal(live(agent('idle'), true), 'idle')
  // No agent, or one that ended: only whether a program runs under the shell.
  assert.equal(live(undefined, true), 'running')
  assert.equal(live(undefined, false), 'idle')
  assert.equal(live(undefined, undefined), 'idle')
  assert.equal(live(agent('ended'), true), 'running')
  assert.equal(live(agent('ended'), false), 'idle')
})

test('deriveActivity: connection state wins over agent state', () => {
  assert.equal(s.deriveActivity({ conn: 'exited', agent: agent('working'), hostBusy: true }), 'exited')
  for (const conn of ['connecting', 'lost', 'failed']) {
    assert.equal(s.deriveActivity({ conn, agent: agent('working'), hostBusy: true }), 'offline', conn)
  }
})

test('output alone never makes a plain shell look busy (no guessing)', () => {
  // Recent output is not an input to the decision at all.
  assert.equal(s.deriveActivity({ conn: 'live', agent: undefined, hostBusy: false, lastOutputAt: Date.now() }), 'idle')
})

test('alertFor: blocked and failed are urgent, finished is quiet, working is silent', () => {
  assert.deepEqual(s.alertFor('working', signal('needs-you', 'Permission: Bash: ls')), { level: 'urgent', label: 'needs you', reason: 'Needs you: Permission: Bash: ls' })
  assert.deepEqual(s.alertFor('working', signal('failed', 'rate_limit')), { level: 'urgent', label: 'failed', reason: 'Failed: rate_limit' })
  assert.equal(s.alertFor('working', signal('finished')).level, 'quiet')
  assert.equal(s.alertFor('finished', signal('working')), undefined)
  assert.equal(s.alertFor('working', signal('ended')), undefined)
  assert.equal(s.alertFor(undefined, signal('idle')), undefined)
  assert.equal(s.alertFor('working', signal('needs-you')).reason, 'Needs you')
})

test('alertFor: a repeated state does not alert twice', () => {
  // Claude reports both a permission request and a notification for one prompt, and an idle notice after Stop.
  assert.equal(s.alertFor('needs-you', signal('needs-you', 'again')), undefined)
  assert.equal(s.alertFor('finished', signal('finished')), undefined)
  assert.equal(s.alertFor('failed', signal('failed')), undefined)
})

test('exitAlert: urgent when an agent was mid-task or the code is non-zero, else quiet', () => {
  assert.equal(s.exitAlert('working', 0).level, 'urgent')
  assert.equal(s.exitAlert('needs-you', 0).level, 'urgent')
  assert.equal(s.exitAlert(undefined, 2).level, 'urgent')
  assert.match(s.exitAlert(undefined, 2).reason, /code 2/)
  assert.equal(s.exitAlert('finished', 0).level, 'quiet')
  assert.equal(s.exitAlert(undefined, 0).level, 'quiet')
  assert.equal(s.exitAlert(undefined, null).level, 'quiet')
})

test('hungAlert: only a working agent, quiet long enough, with the check enabled', () => {
  const min = 60_000
  assert.equal(s.hungAlert(agent('working'), 0, 9 * min, 10), undefined)
  assert.equal(s.hungAlert(agent('working'), 0, 10 * min, 10).level, 'urgent')
  assert.equal(s.hungAlert(agent('working'), 0, 99 * min, 0), undefined, '0 minutes turns it off')
  assert.equal(s.hungAlert(agent('needs-you'), 0, 99 * min, 10), undefined)
  assert.equal(s.hungAlert(undefined, 0, 99 * min, 10), undefined)
  // Output resets the clock.
  assert.equal(s.hungAlert(agent('working'), 9 * min, 10 * min, 10), undefined)
  // So does a state change: `since` is the later of the two.
  assert.equal(s.hungAlert({ ...agent('working'), since: 9 * min }, 0, 10 * min, 10), undefined)
})

// ── attention: applying signals to a runtime ──

/** The parts of a Runtime the attention logic touches; no xterm needed. */
function fakeRuntime(id) {
  return {
    id,
    conn: 'live',
    title: '',
    agent: undefined,
    hostBusy: undefined,
    activity: 'idle',
    lastOutputAt: 0,
    hungRaised: false,
    attention: false,
    attentionLevel: null,
    attentionLabel: '',
    attentionReason: '',
    // What closeAll/disposeRuntime touches when a test's windows are cleared.
    socket: null,
    timer: undefined,
    killed: false,
    term: { dispose() {} },
    holder: { remove() {} },
  }
}

/** A window plus a fake runtime registered for it. */
function terminalWithRuntime() {
  const id = s.openTerminal({ cwd: 'C:\\a' })
  const rt = fakeRuntime(id)
  s.runtimes.set(id, rt)
  return rt
}

beforeEach(() => s.runtimes.clear())

test('a permission request raises an urgent flag; the next working signal clears it', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, signal('working'))
  assert.equal(rt.activity, 'working')
  assert.equal(rt.attention, false)
  s.applyAgentSignal(rt, signal('needs-you', 'Permission: Bash: ls'))
  assert.equal(rt.activity, 'needs-you')
  assert.equal(rt.attention, true)
  assert.equal(rt.attentionLevel, 'urgent')
  assert.equal(rt.attentionLabel, 'needs you')
  s.applyAgentSignal(rt, signal('working'))
  assert.equal(rt.attention, false)
  assert.equal(rt.attentionLevel, null)
})

test('finishing raises a quiet flag, and a quiet flag never replaces an urgent one', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, signal('working'))
  s.applyAgentSignal(rt, signal('finished'))
  assert.equal(rt.attentionLevel, 'quiet')
  assert.equal(rt.activity, 'finished')

  const blocked = terminalWithRuntime()
  s.applyAgentSignal(blocked, signal('needs-you'))
  s.raiseAttention(blocked, { level: 'quiet', label: 'bell', reason: 'Rang the terminal bell' })
  assert.equal(blocked.attentionLevel, 'urgent')
  assert.equal(blocked.attentionLabel, 'needs you')
})

test('typing into a terminal that needs you counts as answering', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, signal('needs-you'))
  s.noteUserInput(rt)
  assert.equal(rt.agent.state, 'working')
  assert.equal(rt.activity, 'working')
  assert.equal(rt.attention, false)
  // Typing while merely working or finished changes nothing.
  s.noteUserInput(rt)
  assert.equal(rt.agent.state, 'working')
  s.applyAgentSignal(rt, signal('finished'))
  s.noteUserInput(rt)
  assert.equal(rt.agent.state, 'finished')
})

test('the program under the shell vanishing mid-task is an urgent "stopped" flag', () => {
  const rt = terminalWithRuntime()
  s.noteHostBusy(rt, true)
  s.applyAgentSignal(rt, signal('working'))
  s.noteHostBusy(rt, false)
  assert.equal(rt.agent.state, 'ended')
  assert.equal(rt.attentionLevel, 'urgent')
  assert.equal(rt.attentionLabel, 'stopped')
  assert.equal(rt.activity, 'idle')
})

test('the program ending after a finished turn, or with no agent, raises nothing', () => {
  const done = terminalWithRuntime()
  s.applyAgentSignal(done, signal('working'))
  s.applyAgentSignal(done, signal('finished'))
  s.clearAttention(done)
  s.noteHostBusy(done, false)
  assert.equal(done.agent.state, 'ended')
  assert.equal(done.attention, false)

  const plain = terminalWithRuntime()
  s.noteHostBusy(plain, true)
  assert.equal(plain.activity, 'running')
  s.noteHostBusy(plain, false)
  assert.equal(plain.activity, 'idle')
  assert.equal(plain.attention, false)
})

test('restoring an agent after a reload shows the flag but stays silent', () => {
  const rt = terminalWithRuntime()
  s.restoreAgent(rt, { ...signal('needs-you', 'Permission: Bash: ls'), at: 123 })
  assert.equal(rt.agent.state, 'needs-you')
  assert.equal(rt.agent.since, 123)
  assert.equal(rt.attention, true)
  s.restoreAgent(terminalWithRuntime(), null)
})

test('a shell exiting mid-task is urgent; an idle shell exiting is quiet', () => {
  const busy = terminalWithRuntime()
  s.applyAgentSignal(busy, signal('working'))
  busy.conn = 'exited'
  s.noteExit(busy, 0)
  assert.equal(busy.attentionLevel, 'urgent')
  assert.equal(busy.activity, 'exited')

  const idle = terminalWithRuntime()
  idle.conn = 'exited'
  s.noteExit(idle, 0)
  assert.equal(idle.attentionLevel, 'quiet')
})

test('tick flags a working agent that has been silent past the threshold, once', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, signal('working'))
  rt.agent.since = Date.now() - 11 * 60_000
  s.tick()
  assert.equal(rt.attentionLevel, 'urgent')
  assert.equal(rt.attentionLabel, 'stuck?')
  s.clearAttention(rt)
  s.tick()
  assert.equal(rt.attention, false, 'does not re-alert for the same stretch of silence')
  s.applyAgentSignal(rt, signal('working'))
  rt.agent.since = Date.now() - 11 * 60_000
  s.tick()
  assert.equal(rt.attention, true, 'a new turn can be flagged again')
})

test('focusing a terminal clears its attention', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, signal('needs-you'))
  s.focusWin(rt.id)
  assert.equal(rt.attention, false)
  assert.equal(rt.attentionLevel, null)
  assert.equal(rt.attentionLabel, '')
})

test('closing a terminal that is running a program or an agent asks first', () => {
  const rt = terminalWithRuntime()
  s.noteHostBusy(rt, true)
  assert.deepEqual(s.busyAmong([rt.id]).map((w) => w.id), [rt.id])
  s.noteHostBusy(rt, false)
  assert.deepEqual(s.busyAmong([rt.id]), [])
  s.applyAgentSignal(rt, signal('needs-you'))
  assert.equal(s.busyAmong([rt.id]).length, 1)
})

// ── launch command ──

const SETTINGS = 'C:\\Users\\me\\.dsh\\web-terminal\\claude-settings-1.json'
const SETTINGS_ARG = '--settings "C:/Users/me/.dsh/web-terminal/claude-settings-1.json"'
const SESSION = '3f4a3c42-a672-45ff-a7f5-ac6abdc48a8e'

test('withAgentHooks adds --settings after claude and keeps the other flags', () => {
  assert.equal(s.withAgentHooks('claude', SETTINGS), `claude ${SETTINGS_ARG}`)
  assert.equal(s.withAgentHooks('claude --resume', SETTINGS), `claude ${SETTINGS_ARG} --resume`)
  assert.equal(s.withAgentHooks('  claude --continue', SETTINGS), `  claude ${SETTINGS_ARG} --continue`)
})

test('withAgentHooks leaves other commands, an existing --settings and a missing file alone', () => {
  const file = '/home/me/.dsh/web-terminal/s.json'
  for (const command of ['npm run dev', 'claude-code-router start', 'echo claude', 'claude --settings x.json', 'claude --settings=x.json', 'mclaude']) {
    assert.equal(s.withAgentHooks(command, file), command, command)
  }
  assert.equal(s.withAgentHooks('claude', null), 'claude')
  assert.equal(s.withAgentHooks('claude', undefined), 'claude')
  assert.equal(s.withAgentHooks('claude', ''), 'claude')
})

test('commands that are not claude never get a conversation added', () => {
  for (const command of ['npm run dev', 'claude-code-router start', 'echo claude', 'mclaude']) {
    assert.equal(s.withAgentHooks(command, SETTINGS, SESSION), command, command)
  }
  // An existing --settings is kept, but the conversation is still resumed.
  assert.equal(s.withAgentHooks('claude --settings x.json', SETTINGS, SESSION), `claude --settings x.json --resume ${SESSION}`)
})

test('a remembered conversation is resumed by a fresh claude', () => {
  assert.equal(s.withAgentHooks('claude', SETTINGS, SESSION), `claude ${SETTINGS_ARG} --resume ${SESSION}`)
  assert.equal(s.withAgentHooks('claude --model sonnet', SETTINGS, SESSION), `claude ${SETTINGS_ARG} --model sonnet --resume ${SESSION}`)
  // Even when the settings file is unavailable, the conversation still resumes.
  assert.equal(s.withAgentHooks('claude', null, SESSION), `claude --resume ${SESSION}`)
})

test('a bare --resume or --continue becomes a resume of the remembered conversation', () => {
  for (const flag of ['--resume', '-r', '--continue', '-c']) {
    assert.equal(s.withAgentHooks(`claude ${flag}`, SETTINGS, SESSION), `claude ${SETTINGS_ARG} --resume ${SESSION}`, flag)
    assert.equal(s.withAgentHooks(`claude ${flag} --model opus`, SETTINGS, SESSION), `claude ${SETTINGS_ARG} --resume ${SESSION} --model opus`, `${flag} then a flag`)
  }
})

test('a command that already names a conversation is left alone', () => {
  assert.equal(s.withAgentHooks('claude --resume abc-123-def-456', SETTINGS, SESSION), `claude ${SETTINGS_ARG} --resume abc-123-def-456`)
  assert.equal(s.withAgentHooks('claude -r abc-123-def-456', SETTINGS, SESSION), `claude ${SETTINGS_ARG} -r abc-123-def-456`)
  assert.equal(s.withAgentHooks('claude --resume=abc-123-def-456', SETTINGS, SESSION), `claude ${SETTINGS_ARG} --resume=abc-123-def-456`)
})

test('an unsafe or missing conversation id is never put in the command', () => {
  for (const bad of ['x; rm -rf ~', '$(whoami)', '', 'short', '--help', undefined, null]) {
    assert.equal(s.withAgentHooks('claude', SETTINGS, bad), `claude ${SETTINGS_ARG}`, String(bad))
    assert.equal(s.withAgentHooks('claude --resume', SETTINGS, bad), `claude ${SETTINGS_ARG} --resume`, `bare resume, ${String(bad)}`)
  }
  assert.equal(s.isSessionId(SESSION), true)
  assert.equal(s.isSessionId('a;b'), false)
})

// ── remembering the conversation ──

test('a terminal remembers the conversation its agent reports, once a prompt has been sent', () => {
  const rt = terminalWithRuntime()
  const win = () => byId(rt.id)
  s.applyAgentSignal(rt, { ...signal('idle'), session: SESSION })
  assert.equal(win().agentSession, undefined, 'a session that has said nothing yet cannot be resumed')
  s.applyAgentSignal(rt, { ...signal('working'), session: SESSION })
  assert.equal(win().agentSession, SESSION)
  const next = '11111111-2222-3333-4444-555555555555'
  s.applyAgentSignal(rt, { ...signal('finished'), session: next })
  assert.equal(win().agentSession, next, 'the latest id wins (a new conversation after /clear)')
})

test('ending, a missing id and an unsafe id do not change what is remembered', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, { ...signal('working'), session: SESSION })
  s.applyAgentSignal(rt, { ...signal('ended'), session: '99999999-2222-3333-4444-555555555555' })
  s.applyAgentSignal(rt, signal('working'))
  s.applyAgentSignal(rt, { ...signal('working'), session: 'x; rm -rf ~' })
  assert.equal(byId(rt.id).agentSession, SESSION)
})

test('the remembered conversation is restored from the host after a page reload, and saved with the window', async () => {
  const rt = terminalWithRuntime()
  s.restoreAgent(rt, { ...signal('finished'), session: SESSION, at: 1 })
  assert.equal(byId(rt.id).agentSession, SESSION)
  const deadline = Date.now() + 10_000
  while (!JSON.parse(window.localStorage.getItem('dsh.web-terminal.layout.v1') ?? '{"wins":[]}').wins.some((w) => w.id === rt.id && w.agentSession === SESSION) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  const saved = JSON.parse(window.localStorage.getItem('dsh.web-terminal.layout.v1'))
  assert.equal(saved.wins.find((w) => w.id === rt.id).agentSession, SESSION)
})

test('duplicates and saved layouts start fresh conversations', () => {
  const rt = terminalWithRuntime()
  s.applyAgentSignal(rt, { ...signal('working'), session: SESSION })
  s.duplicateWin(rt.id)
  assert.equal(wins()[0].agentSession, undefined)
  s.saveLayout('conv')
  assert.ok(!JSON.stringify(s.getPrefs().layouts.find((l) => l.name === 'conv')).includes(SESSION))
})

// ── preferences added with attention ──

test('setHungMinutes clamps to 0..240; sound and notify toggle', () => {
  s.setHungMinutes(-5)
  assert.equal(s.getPrefs().hungMinutes, 0)
  s.setHungMinutes(9999)
  assert.equal(s.getPrefs().hungMinutes, 240)
  s.setHungMinutes(Number.NaN)
  assert.equal(s.getPrefs().hungMinutes, 0)
  s.setHungMinutes(10)
  s.setSound(false)
  assert.equal(s.getPrefs().sound, false)
  s.setSound(true)
})

// ── a real xterm runtime ──

test('moving the mouse over a terminal that needs you does not answer it; a key press does', () => {
  const id = s.openTerminal({ cwd: 'C:\a' })
  const rt = s.ensureRuntime(byId(id))
  s.openRuntime(rt) // the key press below goes through xterm's textarea
  s.applyAgentSignal(rt, signal('needs-you', 'Permission: Bash: ls'))
  assert.equal(rt.attention, true)

  // A TUI with mouse tracking on makes xterm report every pointer move, and focus changes, as input data.
  let reports = 0
  rt.term.onData(() => reports++)
  for (const report of ['[<35;10;10M', '[<35;11;10M', '[<0;11;10M', '[<0;11;10m', '[I', '[O']) rt.term.input(report)
  assert.equal(reports, 6, 'the reports really did reach the input handler')
  assert.equal(rt.agent.state, 'needs-you')
  assert.equal(rt.attention, true)

  // A real key press (answering the prompt) does clear it.
  rt.term.textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', code: 'Digit1', keyCode: 49, bubbles: true }))
  assert.equal(rt.agent.state, 'working')
  assert.equal(rt.attention, false)
})

// ── broadcast selection ──

// Every store module has its own save timer but they share one localStorage: cancel pending saves instead of sleeping them out.
const settle = async () => quiesceStores()

test('turning broadcast back on keeps a selection the user cleared with None', async () => {
  const f = await loadStore({ fresh: true })
  f.openTerminal({ cwd: 'C:\\a' })
  f.openTerminal({ cwd: 'C:\\b' })
  f.setBroadcast({ on: true })
  assert.equal(f.getBroadcast().ids.size, 2, 'the first time, everything is selected')
  f.setBroadcastTargets([]) // the sidebar's "None"
  f.setBroadcast({ on: false, live: false }) // "Done"
  f.setBroadcast({ on: true })
  assert.equal(f.getBroadcast().ids.size, 0, 'a deliberate empty selection survives')
  f.closeAll()
  await settle()
})

test('a broadcast selection nobody touched is still filled with every window', async () => {
  const f = await loadStore({ fresh: true })
  f.setBroadcast({ on: true }) // no windows yet
  f.setBroadcast({ on: false })
  const a = f.openTerminal({ cwd: 'C:\\a' })
  f.setBroadcast({ on: true })
  assert.deepEqual([...f.getBroadcast().ids], [a])
  f.closeAll()
  await settle()
})

// ── hydrating stored state ──

const LAYOUT_KEY = 'dsh.web-terminal.layout.v1'
const PREFS_KEY = 'dsh.web-terminal.prefs.v1'
const goodWin = (id, extra = {}) => ({ id, title: id, shell: 'default', cwd: 'C:\\x', x: 0, y: 0, w: 0.5, h: 0.5, z: 1, pinned: false, maximized: false, minimized: false, ...extra })

test('corrupt layout JSON still restores the preferences and keeps a copy of the bad value', async () => {
  const f = await loadStore({ fresh: true })
  // Seed after the (slow) load and hydrate in the same tick: a save timer left by an earlier test cannot overwrite the seed in between.
  window.localStorage.setItem(LAYOUT_KEY, 'not json{')
  window.localStorage.setItem(PREFS_KEY, JSON.stringify({ favourites: ['C:\\fav'], recents: ['C:\\r'], sound: false }))
  f.hydrate()
  assert.deepEqual(f.getPrefs().favourites, ['C:\\fav'])
  assert.deepEqual(f.getPrefs().recents, ['C:\\r'])
  assert.equal(f.getPrefs().sound, false)
  assert.equal(f.getWins().length, 0)
  assert.equal(window.localStorage.getItem(`${LAYOUT_KEY}.corrupt`), 'not json{')
  f.closeAll()
  await settle()
})

test('corrupt preferences keep the layout, are backed up before the next save, and do not crash', async () => {
  const f = await loadStore({ fresh: true })
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ wins: [goodWin('w1')], zTop: 3 }))
  window.localStorage.setItem(PREFS_KEY, '{broken')
  f.hydrate()
  assert.deepEqual(f.getWins().map((w) => w.id), ['w1'])
  assert.equal(f.getPrefs().lastShell, 'default')
  assert.equal(window.localStorage.getItem(`${PREFS_KEY}.corrupt`), '{broken', 'the raw value survives the overwrite below')
  f.toggleFavourite('C:\\new')
  const deadline2 = Date.now() + 10_000
  while (window.localStorage.getItem(PREFS_KEY) === '{broken' && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(JSON.parse(window.localStorage.getItem(PREFS_KEY)).favourites, ['C:\\new'])
  f.closeAll()
  await settle()
})

test('malformed preference shapes are repaired field by field instead of crashing the view', async () => {
  window.localStorage.setItem(PREFS_KEY, JSON.stringify({
    recents: 'C:\\x',
    favourites: ['C:\\ok', 5, null],
    layouts: [
      { name: 'nowins' },
      { name: 'badwins', wins: 'x' },
      7,
      { name: 'good', savedAt: 5, wins: [{ title: 'A', shell: 'cmd', cwd: 'C:\\a', x: 0, y: 0, w: 1, h: 1 }, { title: 'no rect' }, null] },
    ],
    fitCols: 'wide',
    hungMinutes: 9999,
    termTheme: 'neon',
    sound: 'yes',
  }))
  const f = await loadStore({ fresh: true })
  f.hydrate()
  const p = f.getPrefs()
  assert.deepEqual(p.recents, [])
  assert.deepEqual(p.favourites, ['C:\\ok'])
  assert.deepEqual(p.layouts.map((l) => l.name), ['good'])
  assert.equal(p.layouts[0].wins.length, 1)
  assert.equal(p.layouts[0].wins[0].shell, 'cmd')
  assert.equal(p.fitCols, 100)
  assert.equal(p.hungMinutes, 240)
  assert.equal(p.termTheme, 'dark')
  assert.equal(p.sound, true)
  f.closeAll()
  await settle()
})

test('stored windows are validated: bad ids and geometry are dropped, a missing z is repaired', async () => {
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({
    wins: [goodWin('ok', { z: 4 }), goodWin('noz', { z: undefined }), goodWin('nan', { x: 'left' }), { title: 'no id', x: 0, y: 0, w: 1, h: 1, z: 1 }, goodWin('ok', { z: 9 }), null],
    zTop: 'high',
  }))
  const f = await loadStore({ fresh: true })
  f.hydrate()
  assert.deepEqual(f.getWins().map((w) => w.id), ['ok', 'noz'])
  assert.ok(f.getWins().every((w) => Number.isFinite(w.z)))
  const id = f.openTerminal({ cwd: 'C:\\n' })
  assert.ok(Number.isFinite(f.getWins().find((w) => w.id === id).z), 'zTop is not NaN')
  f.closeAll()
  await settle()
})

// ── host probe ──

test('a failed host probe is retried, and a refresh drops the stale settings file', async () => {
  const f = await loadStore({ fresh: true })
  const calls = []
  const info = (file) => () => Promise.resolve({ ok: true, json: async () => ({ agent: { claudeSettings: file } }) })
  const answers = [() => Promise.reject(new Error('offline')), () => Promise.resolve({ ok: false }), info('C:\\h\\settings-1.json'), info('C:\\h\\settings-2.json')]
  const realFetch = globalThis.fetch
  globalThis.fetch = (...args) => (calls.push(args), answers[calls.length - 1]())
  try {
    await f.hostInfoReady(1000)
    assert.equal(f.hostInfo.agent, undefined, 'first probe failed')
    await f.hostInfoReady(1000)
    assert.equal(f.hostInfo.agent, undefined, 'second probe answered with an error status')
    await f.hostInfoReady(1000)
    assert.equal(f.hostInfo.agent.claudeSettings, 'C:\\h\\settings-1.json', 'a later call retries and succeeds')
    await f.hostInfoReady(1000)
    assert.equal(calls.length, 3, 'a good answer is not asked for again')
    f.refreshHostInfo() // the host restarted
    assert.equal(f.hostInfo.agent, undefined, 'the dead host file is not used while the new probe is in flight')
    await f.hostInfoReady(1000)
    assert.equal(f.hostInfo.agent.claudeSettings, 'C:\\h\\settings-2.json')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── saved layouts keep auto names automatic ──

test('a saved layout freezes only the names the user chose', () => {
  s.openTerminal({ cwd: 'C:\\a', title: 'Mine' })
  const auto = s.openTerminal({ cwd: 'C:\\b' })
  s.updateWin(auto, { autoName: 'Fix login bug' })
  s.saveLayout('names')
  const saved = s.getPrefs().layouts.find((l) => l.name === 'names').wins
  assert.equal(saved.find((w) => w.cwd === 'C:\\a').nameManual, true)
  assert.equal(saved.find((w) => w.cwd === 'C:\\b').nameManual, false)
  s.closeAll()
  s.loadLayout('names')
  assert.equal(wins().find((w) => w.cwd === 'C:\\a').nameManual, true)
  assert.equal(wins().find((w) => w.cwd === 'C:\\b').nameManual, false, 'the reopened window names itself from its program again')
})

// ── typing acknowledges quiet alerts ──

test('typing into a terminal clears a quiet flag (finished, bell) but not an urgent one', () => {
  const done = terminalWithRuntime()
  s.applyAgentSignal(done, signal('working'))
  s.applyAgentSignal(done, signal('finished'))
  assert.equal(done.attentionLevel, 'quiet')
  s.noteUserInput(done)
  assert.equal(done.attention, false)
  assert.equal(done.agent.state, 'finished', 'only the flag goes; the agent state is unchanged')

  const bell = terminalWithRuntime()
  s.raiseAttention(bell, { level: 'quiet', label: 'bell', reason: 'Rang the terminal bell' })
  assert.equal(bell.attention, true)
  s.noteUserInput(bell)
  assert.equal(bell.attention, false)

  const failed = terminalWithRuntime()
  s.applyAgentSignal(failed, signal('failed', 'rate_limit'))
  s.noteUserInput(failed)
  assert.equal(failed.attentionLevel, 'urgent', 'a failure stays until the window is focused')
})

test('stored font: old untouched default (flag set or not) adopts the new defaults; real choices survive; bad values are clamped', async () => {
  const OLD = "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace"
  let f = await loadStore({ fresh: true })
  const loaded = []
  // hydrate runs once per load, so each case gets a fresh store (seeded and hydrated in one tick).
  const hydrateWith = async (p) => {
    f = await loadStore({ fresh: true })
    loaded.push(f)
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p))
    f.hydrate()
    return f.getPrefs()
  }
  let p = await hydrateWith({ fontCustom: false, font: { family: OLD, size: 12, lineHeight: 1.2 } })
  assert.deepEqual(p.font, f.DEFAULT_FONT)
  p = await hydrateWith({ fontCustom: true, font: { family: OLD, size: 12, lineHeight: 1.2 } })
  assert.deepEqual(p.font, f.DEFAULT_FONT, 'Reset font / an untouched edit stored the old default with fontCustom set')
  assert.equal(p.fontCustom, false, 'so later default changes still reach them')
  p = await hydrateWith({ fontCustom: true, font: { family: 'Menlo', size: 12, lineHeight: 1.2 } })
  assert.equal(p.font.family, 'Menlo')
  assert.equal(p.font.size, 12, 'a chosen family keeps its size')
  assert.equal(p.font.minContrast, 4.5, 'new fields missing from old storage take defaults')
  p = await hydrateWith({ fontCustom: true, font: { family: OLD, size: 16, lineHeight: 1.2 } })
  assert.equal(p.font.size, 16)
  p = await hydrateWith({ fontCustom: true, font: { family: 'X', size: 14, lineHeight: 1.3, letterSpacing: 50, boldWeight: 'heavy', minContrast: -4 } })
  assert.deepEqual([p.font.letterSpacing, p.font.boldWeight, p.font.minContrast], [2, 600, 1])
  p = await hydrateWith({ fontCustom: true, font: { family: 'X', size: 14, lineHeight: 1.3, boldWeight: 640, minContrast: 'x' } })
  assert.deepEqual([p.font.boldWeight, p.font.minContrast], [600, 4.5])
  for (const l of loaded) l.closeAll()
  await settle()
})

test('toggleMaximize twice restores the layout (focus mode)', () => {
  const a = s.openTerminal({ cwd: 'C:\a' })
  const before = s.getWins().find((w) => w.id === a)
  const { x, y, w, h } = before
  s.toggleMaximize(a)
  assert.equal(s.getWins().find((win) => win.id === a).maximized, true)
  s.toggleMaximize(a)
  const after = s.getWins().find((win) => win.id === a)
  assert.deepEqual({ x: after.x, y: after.y, w: after.w, h: after.h, max: after.maximized }, { x, y, w, h, max: false })
})
