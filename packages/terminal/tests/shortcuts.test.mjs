// The shortcut registry (src/client/shortcuts.ts) is what the help panel lists AND what the key handlers
// match with. These tests keep the two honest: every registry chord is acted on by the real terminal key
// handler, and the handler acts on no chord the registry does not list.
//
//   node --test tests/shortcuts.test.mjs

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, window } from './helpers/load-store.mjs'

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
  s.closeSendMenu()
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

/** Command blocks as the shell integration reports them: one that worked, one that failed, then the open prompt. */
const BLOCKS =
  [['ls', 0], ['false', 1]].map(([cmd, code]) => `\x1b]133;A\x07$ \x1b]133;B\x07${cmd}\r\n\x1b]633;E;${cmd}\x07\x1b]133;C\x07out\r\n\x1b]133;D;${code}\x07`).join('') + '\x1b]133;A\x07$ \x1b]133;B\x07'

/** A runtime, attached to a fake host, with its xterm key handler (and, with `blocks`, finished commands to navigate). */
async function open(blocks = false) {
  const count = FakeWebSocket.instances.length
  const id = s.openTerminal({ cwd: 'C:\\work' })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt)
  const sock = await until(() => FakeWebSocket.instances[count], 'a socket')
  sock.push({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null })
  rt.term.write(blocks ? BLOCKS : 'some output\r\n')
  await new Promise((resolve) => rt.term.write('', resolve))
  const handler = rt.term._core._customKeyEventHandler
  assert.equal(typeof handler, 'function', 'xterm keeps the custom key handler')
  return { rt, handler }
}

const ev = (init) => new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

/** Every key a chord names, as events, over every modifier combination. */
const MODS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const modsOf = (n) => ({ ctrlKey: !!(n & 1), shiftKey: !!(n & 2), altKey: !!(n & 4), metaKey: !!(n & 8) })
const KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map((k) => ({ key: k, code: `Key${k.toUpperCase()}` })),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((k) => ({ key: k, code: `Key${k}` })),
  { key: ' ', code: 'Space' },
  { key: 'Enter', code: 'Enter' },
  { key: 'Escape', code: 'Escape' },
  { key: 'Tab', code: 'Tab' },
  { key: 'ArrowLeft', code: 'ArrowLeft' },
  { key: 'ArrowRight', code: 'ArrowRight' },
  { key: 'ArrowUp', code: 'ArrowUp' },
  { key: 'ArrowDown', code: 'ArrowDown' },
  ...Array.from({ length: 12 }, (_, i) => ({ key: `F${i + 1}`, code: `F${i + 1}` })),
]

test('every shortcut has a unique id, a known group and either a chord or display keys', () => {
  const ids = new Set()
  for (const sc of s.SHORTCUTS) {
    assert.ok(!ids.has(sc.id), `duplicate id ${sc.id}`)
    ids.add(sc.id)
    assert.ok(s.SHORTCUT_GROUPS.includes(sc.group), `${sc.id}: unknown group ${sc.group}`)
    assert.ok(sc.desc.length > 0)
    assert.ok(sc.chord !== undefined || (sc.keys ?? '').length > 0, `${sc.id}: nothing to show or match`)
  }
  for (const g of s.SHORTCUT_GROUPS) assert.ok(s.SHORTCUTS.some((x) => x.group === g), `group ${g} is empty`)
})

test('formatShortcut: platform variants and key names', () => {
  const by = (id) => s.SHORTCUTS.find((x) => x.id === id)
  assert.equal(s.formatShortcut(by('unread'), false), 'Ctrl+Shift+U')
  assert.equal(s.formatShortcut(by('unread'), true), 'Cmd+Shift+U')
  assert.equal(s.formatShortcut(by('cycle'), false), 'Ctrl+Alt+←/→')
  assert.equal(s.formatShortcut(by('cycle'), true), 'Ctrl+Option+←/→', 'Ctrl stays Ctrl on macOS: Cmd+arrows are the system\'s')
  assert.equal(s.formatShortcut(by('overview'), false), 'Ctrl+Shift+Space')
  assert.equal(s.formatShortcut(by('find'), false), 'Ctrl+F')
  assert.equal(s.formatShortcut(by('help'), false), 'F1')
  assert.equal(s.formatShortcut(by('find-step'), false), 'Enter · Shift+Enter', 'widget-only keys show their text')
})

test('filterShortcuts: every word must match the group, text or keys', () => {
  const ids = (q) => s.filterShortcuts(s.SHORTCUTS, q, false).map((x) => x.id)
  assert.equal(ids('').length, s.SHORTCUTS.length)
  assert.deepEqual(ids('ctrl+shift+u'), ['unread'])
  assert.ok(ids('find').includes('find') && !ids('find').includes('unread'))
  assert.deepEqual(ids('paste clipboard'), ['paste'])
  assert.deepEqual(ids('zzzz'), [])
})

test('matches: modifiers are exact unless the chord says "any"', () => {
  const find = s.SHORTCUTS.find((x) => x.id === 'find').chord
  assert.equal(s.matches(find, ev({ key: 'f', ctrlKey: true })), true)
  assert.equal(s.matches(find, ev({ key: 'F', metaKey: true })), true, 'Cmd works as the modifier')
  assert.equal(s.matches(find, ev({ key: 'f', ctrlKey: true, shiftKey: true })), false)
  assert.equal(s.matches(find, ev({ key: 'f' })), false)
  const cycle = s.SHORTCUTS.find((x) => x.id === 'cycle').chord
  assert.equal(s.matches(cycle, ev({ key: 'ArrowLeft', ctrlKey: true, altKey: true })), true)
  assert.equal(s.matches(cycle, ev({ key: 'ArrowLeft', ctrlKey: true })), false)
  assert.equal(s.matches(cycle, ev({ key: 'ArrowLeft', metaKey: true, altKey: true })), false, 'Ctrl only: Cmd is not Ctrl here')
})

/** Registry chords that act on a key, given whether the terminal has a selection and command blocks to go to. */
function expected(event, selected, blocks) {
  return s.SHORTCUTS.filter((sc) => sc.chord !== undefined && (!sc.needsSelection || selected) && (!sc.needsBlocks || blocks) && s.matches(sc.chord, event)).map((sc) => sc.id)
}

for (const [selected, blocks] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`the real terminal key handler acts on exactly the registry chords (${selected ? 'with' : 'without'} a selection, ${blocks ? 'with' : 'without'} command blocks)`, async () => {
    const { rt, handler } = await open(blocks)
    if (blocks) assert.equal(rt.blocks.list().length, 3, 'two finished commands and the open prompt')
    if (selected) rt.term.selectAll()
    else rt.term.clearSelection()
    const wrong = []
    let hits = 0
    for (const k of KEYS) {
      for (const m of MODS) {
        const event = ev({ ...k, ...modsOf(m) })
        s.closeSendMenu()
        const consumed = handler(event) === false
        const ids = expected(event, selected, blocks)
        if (consumed) hits++
        if (consumed !== ids.length > 0) wrong.push(`${event.ctrlKey ? 'C' : ''}${event.altKey ? 'A' : ''}${event.shiftKey ? 'S' : ''}${event.metaKey ? 'M' : ''}+${k.key}: handler ${consumed ? 'acts' : 'ignores'}, registry says [${ids}]`)
        if (selected) rt.term.selectAll()
      }
    }
    assert.deepEqual(wrong, [], 'handler and registry disagree')
    assert.ok(hits > (blocks ? 22 : 20), 'the sweep reached real shortcuts')
  })
}

test('every handler chord in the registry does its job in the real terminal', async () => {
  const { rt, handler } = await open()
  const fire = (id, init = {}) => {
    const chord = s.SHORTCUTS.find((x) => x.id === id).chord
    const key = chord.key[0]
    const event = ev({ key, ctrlKey: chord.mod !== undefined, shiftKey: chord.shift === true, altKey: chord.alt === true, ...init })
    return { event, consumed: handler(event) === false }
  }
  // Find opens the find bar on this terminal.
  assert.equal(fire('find').consumed, true)
  assert.equal(s.getSearchId(), rt.id)
  s.closeSearch()
  // Send needs a selection, and opens the picker.
  assert.equal(fire('send').consumed, false, 'plain key without a selection')
  rt.term.selectAll()
  assert.equal(fire('send').consumed, true)
  assert.equal(s.getSendRequest()?.sourceId, rt.id)
  s.closeSendMenu()
  // The app-level chords are claimed so the terminal never types them.
  for (const id of ['cycle', 'overview', 'help']) assert.equal(fire(id, id === 'overview' ? { key: ' ', code: 'Space' } : {}).consumed, true, id)
  // Copy: with a selection plain Ctrl+C is claimed; Ctrl+Shift+C always; paste Ctrl+Shift+V.
  assert.equal(fire('copy').consumed, true)
  rt.term.clearSelection()
  assert.equal(fire('copy').consumed, false, 'without a selection Ctrl+C reaches the program')
  assert.equal(fire('copy-always').consumed, true)
  assert.equal(fire('paste').consumed, true)
})

test('the command-block shortcuts: Ctrl+Shift+Up/Down and Ctrl+Shift+E, listed under their own group', () => {
  const by = (id) => s.SHORTCUTS.find((x) => x.id === id)
  assert.equal(s.formatShortcut(by('block-nav'), false), 'Ctrl+Shift+↑/↓')
  assert.equal(s.formatShortcut(by('block-nav'), true), 'Cmd+Shift+↑/↓')
  assert.equal(s.formatShortcut(by('block-failed'), false), 'Ctrl+Shift+E')
  assert.equal(by('block-nav').group, 'Command blocks')
  assert.ok(by('block-nav').needsBlocks && by('block-failed').needsBlocks, 'both fall through to the program without blocks')
  // No other chord in the registry is the same key combination (the sweep above proves the handler agrees).
  const ev1 = ev({ key: 'ArrowUp', ctrlKey: true, shiftKey: true })
  assert.deepEqual(s.SHORTCUTS.filter((x) => x.chord && s.matches(x.chord, ev1)).map((x) => x.id), ['block-nav'])
  const ev2 = ev({ key: 'e', ctrlKey: true, shiftKey: true })
  assert.deepEqual(s.SHORTCUTS.filter((x) => x.chord && s.matches(x.chord, ev2)).map((x) => x.id), ['block-failed'])
  assert.deepEqual(s.filterShortcuts(s.SHORTCUTS, 'command blocks', false).map((x) => x.id).sort(), ['block-failed', 'block-nav'])
})
