// "Changed by agent" marks: mapping a terminal's absolute paths into the open root (Windows case / slashes), parent
// folder propagation, the hover text, and removal when the terminal goes away.
//
//   node --test tests/agent-marks.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDITS_EVENT, EMPTY_MARKS, buildMarks, createAgentMarkSource, dirMarked, markFor, markTitle } from '../src/client/agent-marks.ts'

const term = (files, over = {}) => ({ terminalId: 't1', name: 'api', live: true, files, ...over })
const f = (path, at = 1000, tool = 'Edit') => ({ path, at, tool })

test('Windows root: drive-letter case and slash style do not matter, the relative path keeps its own spelling in the key', () => {
  const marks = buildMarks('C:\\Users\\Me\\Proj', [term([f('c:/users/me/proj/src/App.ts'), f('C:\\USERS\\ME\\PROJ\\README.md')])])
  assert.ok(markFor(marks, 'src/App.ts'))
  assert.ok(markFor(marks, 'SRC/app.TS'), 'lookups are case-insensitive on a Windows root')
  assert.ok(markFor(marks, 'README.md'))
  assert.equal(markFor(marks, 'src/other.ts'), undefined)
})

test('a Git Bash style path (/c/Users/...) maps into a Windows root', () => {
  const marks = buildMarks('C:\\Users\\Me\\Proj', [term([f('/c/Users/Me/Proj/a.ts')])])
  assert.ok(markFor(marks, 'a.ts'))
})

test('POSIX root: case-sensitive; files outside the root, the root itself and sibling-prefixed folders are ignored', () => {
  const marks = buildMarks('/work/proj', [term([f('/work/proj/A.ts'), f('/work/proj-other/b.ts'), f('/work/proj'), f('/etc/x')])])
  assert.ok(markFor(marks, 'A.ts'))
  assert.equal(markFor(marks, 'a.ts'), undefined)
  assert.equal(marks.files.size, 1)
})

test('parent folders are marked (not the root, not siblings)', () => {
  const marks = buildMarks('/w', [term([f('/w/src/deep/x.ts'), f('/w/top.ts')])])
  assert.ok(dirMarked(marks, 'src'))
  assert.ok(dirMarked(marks, 'src/deep'))
  assert.equal(dirMarked(marks, 'docs'), false)
  assert.equal(dirMarked(marks, 'src/deep/x.ts'), false, 'a file is not a folder')
  assert.deepEqual([...marks.dirs].sort(), ['src', 'src/deep'])
})

test('several terminals on one file: newest first, each named', () => {
  const marks = buildMarks('/w', [term([f('/w/a.ts', 1000)], { terminalId: 'a', name: 'one' }), term([f('/w/a.ts', 3000, 'Write')], { terminalId: 'b', name: 'two', color: '#f00' })])
  const entries = markFor(marks, 'a.ts')
  assert.deepEqual(entries.map((e) => [e.name, e.at, e.tool, e.color]), [['two', 3000, 'Write', '#f00'], ['one', 1000, 'Edit', undefined]])
  const text = markTitle(entries, (at) => `t${at}`)
  assert.equal(text, 'Changed by Claude · two · t3000 (Write)\nChanged by Claude · one · t1000 (Edit)')
})

test('hover text format with the real clock', () => {
  const at = new Date(2026, 0, 5, 14, 32).getTime()
  assert.match(markTitle([{ terminalId: 't', name: 'api', at, tool: 'Edit' }]), /^Changed by Claude · api · 14[:.]32 \(Edit\)$/)
})

test('no root, junk entries and empty input give no marks', () => {
  assert.equal(buildMarks(null, [term([f('/w/a.ts')])]), EMPTY_MARKS)
  assert.equal(buildMarks('/w', []).files.size, 0)
  assert.equal(buildMarks('/w', [term([{ path: 5 }, null, f('relative/x.ts')])]).files.size, 0)
  assert.equal(markFor(EMPTY_MARKS, 'a.ts'), undefined)
})

// ---- the live source --------------------------------------------------------------------------------------------

function fakeWindow() {
  const target = new EventTarget()
  const subs = new Set()
  let terminals = []
  const win = {
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
  }
  const install = () => {
    win.__dshTerminals = { version: 1, listEdits: () => terminals, subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb) } }
  }
  return {
    win, install, subs,
    set(next) { terminals = next },
    emit() { for (const cb of [...subs]) cb() },
    event() { target.dispatchEvent(new Event(EDITS_EVENT)) },
  }
}

test('source: follows the terminals through subscribe, drops the mark when the terminal closes, unsubscribes on the last listener', () => {
  const w = fakeWindow()
  w.install()
  w.set([term([f('c:/proj/a.ts')])])
  const src = createAgentMarkSource(w.win)
  src.setRoot('C:\\proj')
  let calls = 0
  const off = src.subscribe(() => { calls++ })
  assert.ok(markFor(src.get(), 'a.ts'), 'marks present at subscribe time')
  w.set([term([f('c:/proj/a.ts'), f('c:/proj/b.ts')])])
  w.emit()
  assert.ok(markFor(src.get(), 'b.ts'))
  const callsBefore = calls
  w.emit()
  assert.equal(calls, callsBefore, 'an unchanged list does not notify')
  w.set([])
  w.emit()
  assert.equal(markFor(src.get(), 'a.ts'), undefined, 'terminal closed: marker gone')
  assert.equal(src.get().files.size, 0)
  off()
  assert.equal(w.subs.size, 0, 'the API subscription is released')
})

test('source: the window event also refreshes; a late-loading API is picked up by polling; root changes re-map', async () => {
  const w = fakeWindow()
  const src = createAgentMarkSource(w.win)
  src.setRoot('/w')
  let calls = 0
  const off = src.subscribe(() => { calls++ })
  assert.equal(src.get().files.size, 0, 'no API yet: no marks, no crash')
  w.install()
  w.set([term([f('/w/a.ts')])])
  w.event()
  assert.ok(markFor(src.get(), 'a.ts'), 'the event is enough')
  assert.equal(w.subs.size, 1, 'and the subscribe API gets hooked up')
  src.setRoot('/other')
  assert.equal(src.get().files.size, 0, 'a different root maps nothing')
  src.setRoot('/w')
  assert.ok(markFor(src.get(), 'a.ts'))
  assert.ok(calls >= 3)
  off()
})

test('source: a throwing API does not break the editor', () => {
  const w = fakeWindow()
  w.win.__dshTerminals = { listEdits: () => { throw new Error('boom') }, subscribe: () => () => {} }
  const src = createAgentMarkSource(w.win)
  src.setRoot('/w')
  const off = src.subscribe(() => {})
  assert.equal(src.get().files.size, 0)
  off()
})
