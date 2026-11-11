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

// ── 6. the live folder ──

test('the window header and the terminal list show the folder the shell is in now', async () => {
  const id = v.openTerminal({ cwd: 'C:\work\start' })
  render()
  const rt = await until(() => v.getRuntime(id), 'the runtime')
  const sock = await until(() => FakeWebSocket.last, 'the socket')
  sock.push({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null })
  await until(() => q('.wt-win .wt-sub')?.textContent === 'C:\work\start', 'the starting folder')
  assert.match(q('.wt-li-sub').textContent, /start/)
  rt.term.write('\x1b]633;P;Cwd=C:\work\elsewhere\x07')
  await until(() => q('.wt-win .wt-sub')?.textContent === 'C:\work\elsewhere', 'the header to follow the shell')
  assert.equal(q('.wt-win .wt-sub').title, 'C:\work\elsewhere')
  assert.match(q('.wt-li-sub').textContent, /elsewhere/, 'and the list too')
  assert.equal(v.getWins()[0].cwd, 'C:\work\start', 'the saved start folder is untouched')
})

// ── 12. reconnect button ──

test('a window opened in another tab offers a Reconnect button', async () => {
  const id = v.openTerminal({ cwd: 'C:\work' })
  render()
  const rt = await until(() => v.getRuntime(id), 'the runtime')
  const sock = await until(() => FakeWebSocket.last, 'the socket')
  sock.push({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null })
  assert.equal(q('.wt-win [data-act="reconnect"]'), null, 'no button while live')
  v.flushSync(() => sock.drop(4000))
  assert.ok(rt.conn === 'lost')
  const button = await until(() => q('.wt-win [data-act="reconnect"]'), 'the button')
  const before = FakeWebSocket.instances.length
  click(button)
  assert.equal(FakeWebSocket.instances.length, before + 1)
  assert.equal(q('.wt-win [data-act="reconnect"]'), null, 'gone once reconnecting')
})

// ── 13. maximize on a pinned window ──

test('the maximize button is disabled, with a tooltip, on a pinned window', async () => {
  const id = v.openTerminal({ cwd: 'C:\work' })
  render()
  await until(() => q('.wt-win [data-act="maximize"]'), 'the button')
  const button = () => q('.wt-win [data-act="maximize"]')
  assert.equal(button().disabled, false)
  v.flushSync(() => v.updateWin(id, { pinned: true }))
  assert.equal(button().disabled, true)
  assert.match(button().title, /Unpin/)
  v.flushSync(() => v.updateWin(id, { pinned: false }))
  assert.equal(button().disabled, false)
})

// ── 16. keyboard access ──

const press = (el, k) => v.flushSync(() => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))

test('terminal list rows are focusable and Enter / Space focus the terminal', async () => {
  const a = v.openTerminal({ cwd: 'C:\a' })
  const b = v.openTerminal({ cwd: 'C:\b' })
  render()
  await until(() => qa('.wt-li').length === 2, 'both rows')
  const rows = qa('.wt-li').reverse() // newest first: rows[0] is terminal a
  assert.equal(rows[0].tabIndex, 0)
  assert.equal(rows[0].getAttribute('role'), 'button')
  v.focusWin(b)
  press(rows[0], 'Enter')
  assert.equal(v.getFocusId(), a, 'Enter activates the row')
  v.focusWin(b)
  press(rows[0], ' ')
  assert.equal(v.getFocusId(), a, 'Space too')
  // A key pressed on a control inside the row is that control's own.
  v.focusWin(b)
  press(rows[0].querySelector('button'), 'Enter')
  assert.equal(v.getFocusId(), b)
})

test('folder chips in the New terminal dialog take the keyboard', async () => {
  v.getPrefs().recents.splice(0, 99, 'C:/recent/one')
  render()
  click(byText('.wt-bar button', 'New terminal'))
  const chip = q('.wt-dialog .wt-folder')
  assert.ok(chip, 'a recent folder is listed')
  assert.equal(chip.tabIndex, 0)
  press(chip, 'Enter')
  assert.equal(q('.wt-dialog input').value, 'C:/recent/one')
  assert.ok(q('.wt-dialog'), 'Enter on the chip does not open the terminal')
  assert.equal(v.getWins().length, 0)
})

// ── 15. broadcast feedback ──

test('the broadcast bar says when the line did not reach every selected terminal', async () => {
  v.openTerminal({ cwd: 'C:\a' })
  v.openTerminal({ cwd: 'C:\b' })
  render()
  await until(() => FakeWebSocket.instances.length === 2, 'both sockets')
  v.flushSync(() => v.setBroadcast({ on: true }))
  const input = () => q('.wt-bar2 input.wt-input')
  const send = (text) => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(input(), text)
    v.flushSync(() => input().dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })))
    v.flushSync(() => input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  }
  FakeWebSocket.instances[0].drop() // one of two goes away
  send('echo hi')
  assert.match(v.getNotices().map((n) => n.text).join('|'), /Sent to 1 of 2/)
  assert.equal(input().value, '', 'the line was sent, so the field clears')
  FakeWebSocket.instances[1].readyState = 3
  v.clearNotices()
  send('echo again')
  assert.match(v.getNotices().map((n) => n.text).join('|'), /Not sent/)
  assert.equal(input().value, 'echo again', 'an unsent line is kept')
})

// ── 9. dragging and resizing ──

const pointer = (el, type, x, y) => v.flushSync(() => el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })))

test('dragging a window redraws only that window and writes the store once, on release', async () => {
  const id = v.openTerminal({ cwd: 'C:\work' })
  v.updateWin(id, { x: 0.2, y: 0.2, w: 0.4, h: 0.4 })
  render()
  await until(() => q('.wt-win'), 'the window')
  const winEl = q('.wt-win')
  const head = q('.wt-head')
  const before = v.getWins()
  const version = v.getVersion()
  pointer(head, 'pointerdown', 200, 100)
  const left0 = parseFloat(winEl.style.left)
  for (let i = 1; i <= 10; i++) pointer(head, 'pointermove', 200 + i * 10, 100 + i * 5)
  assert.ok(parseFloat(winEl.style.left) > left0, 'the window follows the pointer')
  assert.equal(v.getWins(), before, 'the store is not touched while dragging')
  assert.equal(v.getVersion(), version, 'nothing else redraws')
  pointer(head, 'pointerup', 300, 150)
  const win = v.getWins()[0]
  assert.notEqual(v.getWins(), before)
  assert.ok(win.x > 0.2 && win.y > 0.2, 'the final position is stored')
  assert.equal(parseFloat(winEl.style.left), win.x * 600, 'and is what is shown')
})

test('resizing from a grip also keeps the rectangle local until release', async () => {
  const id = v.openTerminal({ cwd: 'C:\work' })
  v.updateWin(id, { x: 0.1, y: 0.1, w: 0.4, h: 0.5 })
  render()
  await until(() => q('.wt-win .wt-grip[data-d="se"]'), 'the grip')
  const grip = q('.wt-win .wt-grip[data-d="se"]')
  const before = v.getWins()
  pointer(grip, 'pointerdown', 300, 200)
  for (let i = 1; i <= 8; i++) pointer(grip, 'pointermove', 300 + i * 10, 200 + i * 10)
  assert.equal(v.getWins(), before, 'not stored while resizing')
  pointer(grip, 'pointerup', 380, 280)
  const win = v.getWins()[0]
  assert.ok(win.w > 0.4 && win.h > 0.5, 'the grown size is stored on release')
})
