// The terminal -> Code editor link: Ctrl+click target "Code (this app)", the window menu's review item,
// the default for new users and the fallback when the editor plugin is absent.
//
//   node --test tests/code-editor-link.test.mjs

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadStore, quiesceStores, window } from './helpers/load-store.mjs'

let s
const PREFS_KEY = 'dsh.web-terminal.prefs.v1'
const events = []
const onOpen = (e) => events.push(e.detail)
const hostCalls = []

before(async () => {
  s = await loadStore()
  window.addEventListener('dsh-code-editor:open', onOpen)
  globalThis.fetch = async (url, init) => {
    hostCalls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
})
after(() => {
  s.closeAll()
  window.close()
})
afterEach(() => quiesceStores())
beforeEach(() => {
  events.length = 0
  hostCalls.length = 0
  delete window.__dshCodeEditor
  s.setPathTarget('code')
  quiesceStores()
})

/** A runtime stand-in: only `term.element` is used (to show the fallback message). */
const fakeRt = () => ({ term: { element: window.document.createElement('div') } })

test('Code target dispatches dsh-code-editor:open with path, line and col and makes no host call', async () => {
  window.__dshCodeEditor = { version: 1 }
  const rt = fakeRt()
  await s.openPath(rt, 'C:\proj\src\a.ts', 12, 5)
  assert.deepEqual(events, [{ path: 'C:\proj\src\a.ts', line: 12, col: 5 }])
  assert.equal(hostCalls.length, 0)
  assert.equal(rt.term.element.children.length, 0, 'no message')
  await s.openPath(rt, '/home/u/b.py')
  assert.deepEqual(events[1], { path: '/home/u/b.py' }, 'no line/col keys when absent')
})

test('editor absent: falls back to VS Code through the host and shows the small message', async () => {
  const rt = fakeRt()
  await s.openPath(rt, 'C:\proj\a.ts', 3, 1)
  assert.equal(events.length, 0)
  assert.equal(hostCalls.length, 1)
  assert.match(hostCalls[0].url, /\/open$/)
  assert.equal(hostCalls[0].body.target, 'vscode')
  assert.deepEqual([hostCalls[0].body.path, hostCalls[0].body.line, hostCalls[0].body.col], ['C:\proj\a.ts', 3, 1])
  assert.match(rt.term.element.textContent, /not installed/)
  assert.equal(s.getPrefs().pathTarget, 'code', 'the preference itself is untouched')
})

test('a folder never goes to the editor as a file: the host handles it (file manager)', async () => {
  window.__dshCodeEditor = { version: 1 }
  await s.openPath(fakeRt(), 'C:\proj', undefined, undefined, true)
  assert.equal(events.length, 0)
  assert.equal(hostCalls[0].body.target, 'vscode')
})

test('other targets still use the host with that target', async () => {
  window.__dshCodeEditor = { version: 1 }
  s.setPathTarget('cursor')
  await s.openPath(fakeRt(), '/x/y.ts', 1, 1)
  assert.equal(events.length, 0)
  assert.equal(hostCalls[0].body.target, 'cursor')
})

test('review: showReview needs the editor and a local window; reviewFolder dispatches path + review', () => {
  assert.equal(s.showReview(false), false, 'hidden when the editor is not installed')
  window.__dshCodeEditor = { version: 1 }
  assert.equal(s.showReview(false), true)
  assert.equal(s.showReview(true), false, 'hidden for ssh windows')
  assert.equal(s.reviewFolder('C:\proj'), true)
  assert.deepEqual(events, [{ path: 'C:\proj', review: true }])
  assert.equal(s.reviewFolder(''), false)
  assert.equal(s.reviewFolder(undefined), false)
  delete window.__dshCodeEditor
  assert.equal(s.reviewFolder('C:\proj'), false)
  assert.equal(events.length, 1)
})

test('the window menu wires the review item to the shell cwd, else the window cwd, hidden over ssh', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/terminals-view.tsx', import.meta.url), 'utf8')
  assert.match(src, /showReview\(win\.ssh !== undefined\)/)
  assert.match(src, /reviewFolder\(rt\.cwd \|\| win\.cwd\)/)
})

test('defaults: new users get Code; saved preferences keep their target', async () => {
  const fresh = await loadStore({ fresh: true })
  window.localStorage.clear()
  fresh.hydrate()
  assert.equal(fresh.getPrefs().pathTarget, 'code', 'nothing saved')
  fresh.closeAll()
  for (const [saved, expected] of [[{ pathTarget: 'cursor' }, 'cursor'], [{ pathTarget: 'vscode' }, 'vscode'], [{ pathTarget: 'custom' }, 'custom'], [{ pathTarget: 'code' }, 'code'], [{ sound: false }, 'vscode'], [{ pathTarget: 'bogus' }, 'vscode']]) {
    const f = await loadStore({ fresh: true })
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(saved))
    f.hydrate()
    assert.equal(f.getPrefs().pathTarget, expected, JSON.stringify(saved))
    f.closeAll()
    quiesceStores()
    window.localStorage.clear()
  }
})
