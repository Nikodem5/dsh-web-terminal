// Unit tests for the workspace folder choices and the remembered session folder.
//
//   npm test   (or: node --test tests/workspaces.test.mjs)

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { window, loadStore } from './helpers/load-store.mjs'

let s
before(async () => {
  s = await loadStore({ fresh: true })
})
after(() => window.close())

test('workspaceChoices keeps order, titles, and drops unusable or repeated entries', () => {
  const out = s.workspaceChoices([
    { path: 'C:\\a\\proj', title: 'Proj' },
    { path: 'C:\\b\\notes\\', title: '  ' },
    { path: 'c:\\A\\PROJ', title: 'dup' },
    { path: '', title: 'empty' },
    { title: 'no path' },
    null,
    { path: 42 },
  ])
  assert.deepEqual(out, [
    { label: 'Proj', path: 'C:\\a\\proj' },
    { label: 'notes', path: 'C:\\b\\notes\\' },
  ])
})

test('workspaceChoices tolerates a missing or foreign snapshot', () => {
  assert.deepEqual(s.workspaceChoices(undefined), [])
  assert.deepEqual(s.workspaceChoices({ items: [] }), [])
})

test('noteSessionCwd records the folder and ignores empty values', () => {
  s.noteSessionCwd(undefined)
  s.noteSessionCwd('')
  assert.equal(s.getPrefs().sessionCwd, '')
  s.noteSessionCwd('C:\\work\\repo')
  assert.equal(s.getPrefs().sessionCwd, 'C:\\work\\repo')
})
