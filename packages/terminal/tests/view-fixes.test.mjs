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

// ── 4. number inputs in the settings menu ──

/** Type into a controlled input the way a keyboard does (an InputEvent with an inputType). */
function type(input, text) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(input, text)
  v.flushSync(() => input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) })))
}
const blur = (el) => v.flushSync(() => { el.focus(); el.blur() })

test('a number setting is applied when you finish typing, not on every keystroke', async () => {
  render()
  click(byText('.wt-bar button', 'Aa'))
  const field = () => qa('.wt-pop input[type="number"]')[0]
  assert.equal(field().value, '14')
  v.setFont({ size: 14 })
  field().focus()
  type(field(), '1')
  assert.equal(v.getPrefs().font.size, 14, 'a half-typed "1" is not clamped to 8')
  assert.equal(field().value, '1', 'the field keeps what was typed')
  type(field(), '18')
  assert.equal(v.getPrefs().font.size, 14, 'still nothing applied')
  blur(field())
  assert.equal(v.getPrefs().font.size, 18)
  assert.equal(field().value, '18')

  // Out of range: the setter clamps on commit; an emptied field reverts.
  field().focus()
  type(field(), '99')
  blur(field())
  assert.equal(v.getPrefs().font.size, 32)
  assert.equal(field().value, '32')
  type(field(), '')
  blur(field())
  assert.equal(v.getPrefs().font.size, 32, 'an empty field changes nothing')
  assert.equal(field().value, '32')

  // Enter commits; the spinner (no typed character) applies at once.
  type(field(), '20')
  v.flushSync(() => field().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  assert.equal(v.getPrefs().font.size, 20)
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(field(), '21')
  v.flushSync(() => field().dispatchEvent(new window.Event('input', { bubbles: true })))
  assert.equal(v.getPrefs().font.size, 21, 'a spinner step applies immediately')
})

// ── 5. terminal colours that follow the app theme ──

test('open terminals repaint when the app theme changes and colours follow the app', async () => {
  const html = doc.documentElement
  html.setAttribute('data-ds-theme-source', 'test') // the harness publishes its resolved scheme
  doc.body.setAttribute('data-ds-dark-theme', '')
  try {
    v.setTermTheme('auto')
    const id = v.openTerminal({ cwd: 'C:\work' })
    render()
    const rt = await until(() => v.getRuntime(id), 'the runtime')
    assert.equal(rt.term.options.theme.background, '#14161b', 'dark app, dark terminal')
    doc.body.removeAttribute('data-ds-dark-theme')
    await until(() => rt.term.options.theme.background === '#ffffff', 'the terminal to turn light')
    doc.body.setAttribute('data-ds-dark-theme', '')
    await until(() => rt.term.options.theme.background === '#14161b', 'the terminal to turn dark again')
    // A fixed theme does not move with the app.
    v.setTermTheme('dark')
    doc.body.removeAttribute('data-ds-dark-theme')
    await sleep(50)
    assert.equal(rt.term.options.theme.background, '#14161b')
  } finally {
    html.removeAttribute('data-ds-theme-source')
    doc.body.removeAttribute('data-ds-dark-theme')
    v.setTermTheme('dark')
  }
})
