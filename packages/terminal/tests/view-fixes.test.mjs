// Regression tests for fixes that live in the Terminals page itself (React, rendered under jsdom).
//
//   node --test tests/view-fixes.test.mjs

import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, quiesceStores } from './helpers/load-store.mjs'
import { loadView, window } from './helpers/load-view.mjs'

let v // the bundled page and its store
let root
const doc = window.document

before(async () => {
  v = await loadView()
})
after(() => {
  v.closeAll()
  window.close()
})
beforeEach(() => {
  v.closeAll()
  v.runtimes.clear()
  v.clearNotices()
  window.localStorage.clear()
  FakeWebSocket.reset()
  doc.body.innerHTML = '<div id="root"></div>'
  root = v.createRoot(doc.getElementById('root'))
})
afterEach(() => {
  v.flushSync(() => root.unmount())
  quiesceStores()
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

const render = () => v.flushSync(() => root.render(v.React.createElement(v.TerminalsView, {})))
const q = (sel) => doc.querySelector(sel)
const qa = (sel) => [...doc.querySelectorAll(sel)]
const click = (el) => v.flushSync(() => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
const byText = (sel, text) => qa(sel).find((el) => el.textContent.includes(text))
const key = (init) => window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

// ── 3. window shortcuts while the New terminal dialog is open ──

test('Ctrl+Alt+W / Ctrl+Alt+M do not act on the terminal behind the New terminal dialog', async () => {
  const id = v.openTerminal({ cwd: 'C:\\work' })
  render()
  await until(() => qa('.wt-win').length === 1, 'the window')
  const settle = () => sleep(30)
  // Without a dialog the shortcut maximizes.
  key({ key: 'm', ctrlKey: true, altKey: true })
  assert.equal(v.getWins().find((w) => w.id === id).maximized, true, 'focus mode works with no dialog')
  key({ key: 'm', ctrlKey: true, altKey: true })
  assert.equal(v.getWins().find((w) => w.id === id).maximized, false)

  click(byText('.wt-bar button', 'New terminal'))
  assert.ok(q('.wt-dialog'), 'the dialog is open')
  key({ key: 'm', ctrlKey: true, altKey: true })
  key({ key: 'w', ctrlKey: true, altKey: true })
  await settle()
  const win = v.getWins().find((w) => w.id === id)
  assert.ok(win, 'the terminal behind the dialog is still open')
  assert.equal(win.maximized, false, 'and was not maximized')

  // Closing the dialog gives the shortcuts back.
  click(byText('.wt-dialog button', 'Cancel'))
  assert.equal(q('.wt-dialog'), null)
  key({ key: 'm', ctrlKey: true, altKey: true })
  assert.equal(v.getWins().find((w) => w.id === id).maximized, true)
})
