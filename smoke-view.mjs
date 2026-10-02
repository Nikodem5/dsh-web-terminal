// Render test for the Terminals view (development only).
//
// Loads the built bundle into jsdom with a fake WebSocket and drives the real UI:
// open a terminal through the dialog, feed it host frames, and assert the list,
// auto-naming from a Claude-style title, rename, activity state, Ctrl+Alt+→
// switching, broadcast, layouts and safe close.
//
//   node smoke-view.mjs        (needs `jsdom` resolvable, e.g. DSH_JSDOM=<path to jsdom>)

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

const profileRequire = createRequire(
  pathToFileURL(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'profiles', 'package.json')).href,
)
const { JSDOM } = createRequire(import.meta.url)(process.env.DSH_JSDOM ?? 'jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom
let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── browser surface the bundle expects ──
const sockets = []
window.WebSocket = class {
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = 1
    this.sent = []
    sockets.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ shells: [{ id: 'powershell', label: 'PowerShell' }], cwd: 'C:\\Users\\me', claude: { available: true }, sessions: [] }) })
window.confirm = () => true
window.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:19387' }
window.HTMLCanvasElement.prototype.getContext = () => null
// jsdom has no IE-era event API, which React probes when an input takes focus.
window.Element.prototype.attachEvent = () => {}
window.Element.prototype.detachEvent = () => {}
Object.defineProperty(window.Element.prototype, 'clientWidth', { get() { return 600 } })
Object.defineProperty(window.Element.prototype, 'clientHeight', { get() { return 300 } })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// react-dom (running in Node) reads these browser globals.
globalThis.window = window
globalThis.document = window.document
for (const k of ['HTMLElement', 'HTMLIFrameElement', 'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'MutationObserver']) globalThis[k] = window[k]
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)

window.document.oninput = null // makes 'oninput' in document true, as in a real browser
// react must be the copy react-dom itself loads, or elements are rejected as "from an older version".
const domEntry = profileRequire.resolve('react-dom/client')
const domRequire = createRequire(pathToFileURL(domEntry).href)
const React = domRequire('react')
const jsxRuntime = domRequire('react/jsx-runtime')
const ReactDOMClient = domRequire('react-dom/client')
const ReactDOM = domRequire('react-dom')

// ── load the bundle through the stub loader ──
let entry
window.__ModuleLoader__ = { load: (e) => { entry = e } }
window.eval(bundle)
const mods = { react: React, 'react/jsx-runtime': jsxRuntime }
const exportsObject = entry.factory((id) => mods[id])
let component
let injectFn
exportsObject.apply({
  slots: {
    inject: (_key, cb) => { cb(); return () => {} },
    register: (options, comp) => { component = comp; injectFn = options.inject; return () => {} },
  },
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: 'C:\\work\\repo' } } }) } },
})
const props = injectFn('s1')
check(props.sessionCwd() === 'C:\\work\\repo', 'inject exposes the session workspace folder')

// ── render ──
const root = ReactDOMClient.createRoot(window.document.getElementById('root'))
const render = () => ReactDOM.flushSync(() => root.render(React.createElement(component, props)))
const doc = window.document
const q = (sel) => doc.querySelector(sel)
const qa = (sel) => [...doc.querySelectorAll(sel)]
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const byText = (sel, text) => qa(sel).find((el) => el.textContent.includes(text))
const setValue = (input, value) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

render()
await sleep(50)
check(q('.wt-view') !== null, 'view renders')
check(byText('button', 'Sign in') === undefined, 'no "Sign in" button')
check(q('.wt-side') !== null, 'terminal list sidebar renders')

// open the dialog and a terminal
click(byText('.wt-bar button', 'New terminal'))
await sleep(20)
check(q('.wt-dialog') !== null, 'New terminal dialog opens')
check(q('.wt-dialog input').value === 'C:\\Users\\me' || q('.wt-dialog input').value.length > 0, 'dialog has a default folder')
setValue(q('.wt-dialog input'), 'C:\\work\\repo')
await sleep(40)
click(byText('.wt-dialog button', 'claude --resume'))
await sleep(40)
click(byText('.wt-dialog button', 'Open'))
await sleep(120)
check(qa('.wt-win').length === 1, 'a terminal window opens')
const sock = sockets[sockets.length - 1]
check(sock.url.startsWith('ws://127.0.0.1:19387/terminal/ws?') && sock.url.includes('cwd=C%3A%5Cwork%5Crepo'), 'socket targets the host origin with the chosen folder')

// host attaches a fresh shell: startup command is typed

sock.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null })
await sleep(700)
check(sock.sent.some((f) => f.type === 'input' && f.data === 'claude --resume\r'), 'startup command typed into a fresh shell')

// Claude-style title becomes the default name
sock.push({ type: 'data', data: '\x1b]0;\u2733 Fix login bug\x07' })
await sleep(150)
check(q('.wt-li-name')?.textContent === 'Fix login bug', `list shows the Claude session name (got "${q('.wt-li-name')?.textContent}")`)

// output => working, then waiting via host busy flag
sock.push({ type: 'data', data: 'compiling…\r\n' })
await sleep(1200)
check(q('.wt-li .wt-dot')?.dataset.a === 'working', 'recent output shows Working')
sock.push({ type: 'activity', busy: true })
await sleep(3800)
check(q('.wt-li .wt-dot')?.dataset.a === 'waiting', `quiet + running child shows Waiting (got ${q('.wt-li .wt-dot')?.dataset.a})`)

// rename sticks over the auto name
const nameEl = q('.wt-li-name')
nameEl.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
await sleep(20)
const input = q('.wt-li input.wt-name-input')
check(input !== null, 'double-click opens rename')
setValue(input, 'Agent A')
input.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }))
input.blur()
await sleep(30)
sock.push({ type: 'data', data: '\x1b]0;\u2733 Something else\x07' })
await sleep(120)
check(q('.wt-li-name')?.textContent === 'Agent A', `manual rename wins over the auto name (got "${q('.wt-li-name')?.textContent}")`)

// second terminal + Ctrl+Alt+Right switching
click(byText('.wt-bar button', 'New terminal'))
await sleep(20)
click(byText('.wt-dialog button', 'Open'))
await sleep(120)
check(qa('.wt-li').length === 2, 'second terminal appears in the list')
{
  const wins = qa('.wt-win')
  const z = wins.map((w) => Number(w.style.zIndex))
  check(z[0] > z[1], `new terminal has the highest z-index (${z.join(' vs ')})`)
}
const focusedBefore = q('.wt-li[data-focused="true"] .wt-li-name')?.textContent
doc.defaultView.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))
await sleep(40)
const focusedAfter = q('.wt-li[data-focused="true"] .wt-li-name')?.textContent
check(focusedBefore !== focusedAfter, `Ctrl+Alt+Right moves focus (${focusedBefore} -> ${focusedAfter})`)

// newest terminal tops the list and the z-order
{
  const names = qa('.wt-li-name').map((e) => e.textContent)
  check(names[0] === 'Terminal 2', `new terminal is first in the list (got ${JSON.stringify(names)})`)
}

// find bar: opens from the window menu, counts matches in the buffer
{
  const sock2 = sockets[sockets.length - 1]
  sock2.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null })
  sock2.push({ type: 'data', data: 'alpha beta alpha\r\nGAMMA alpha\r\n' })
  await sleep(250)
  click(q('.wt-win .wt-hbtn[title="More"]'))
  await sleep(30)
  click(byText('.wt-pop button', 'Find'))
  await sleep(40)
  check(q('.wt-find') !== null, 'Find opens from the window menu')
  setValue(q('.wt-find input'), 'alpha')
  await sleep(300)
  check(q('.wt-find-count')?.textContent === '1 / 3', `find counts matches (got "${q('.wt-find-count')?.textContent}")`)
  // next match steps the index
  q('.wt-find input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(200)
  check(/^[23] \/ 3$/.test(q('.wt-find-count')?.textContent ?? ''), `Enter steps to the next match (got "${q('.wt-find-count')?.textContent}")`)
  setValue(q('.wt-find input'), 'nomatchhere')
  await sleep(300)
  check(q('.wt-find-count')?.textContent === 'No results', 'find reports No results')
  q('.wt-find input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(40)
  check(q('.wt-find') === null, 'Esc closes the find bar')
}

// smaller default font, and the settings menu shows it
{
  click(byText('.wt-bar button', 'Aa'))
  await sleep(30)
  const numbers = qa('.wt-pop input[type="number"]').map((i) => i.value)
  check(q('.wt-pop select')?.value === 'dark', 'terminal colours default to dark')
  check(q('.wt-view').style.getPropertyValue('--wt-term-bg') === '#14161b', 'window chrome matches the terminal background')
  check(numbers[0] === '12', `default terminal font size is 12 (got ${numbers[0]})`)
  check(byText('.wt-pop .wt-item', 'Shrink font to fit window') !== undefined && numbers.includes('100'), 'settings offer auto-fit font with a 100-column default')
  click(byText('.wt-bar button', 'Aa'))
  await sleep(20)
}

// text colours follow the app's published theme
{
  const view = q('.wt-view')
  check(view.dataset.scheme === 'dark' || view.dataset.scheme === 'light', `view has a scheme (${view.dataset.scheme})`)
  doc.documentElement.setAttribute('data-ds-theme-source', 'light')
  doc.body.removeAttribute('data-ds-dark-theme')
  await sleep(60)
  check(view.dataset.scheme === 'light', `light theme gives dark text (${view.dataset.scheme})`)
  doc.body.setAttribute('data-ds-dark-theme', '')
  await sleep(60)
  check(view.dataset.scheme === 'dark', `dark theme gives light text (${view.dataset.scheme})`)
  doc.body.removeAttribute('data-ds-dark-theme')
  doc.documentElement.setAttribute('data-ds-theme-source', 'light')
  await sleep(40)
}

// stacking: overlays can never end up beneath windows
{
  const css = [...doc.querySelectorAll('style')].map((t) => t.textContent).join('\n')
  check(/data-scheme="light"\][^}]*--wt-surface: #f6f7f9[^}]*--wt-deep: #ffffff/.test(css) && /data-scheme="dark"\][^}]*--wt-surface: #1b1d23/.test(css), 'each scheme sets surface AND text together, so buttons cannot pair text with a mismatched background')
  check(/:has\(\.wt-view\) > \[class\*="composerSeat"\][^}]*display: none/.test(css) && !/dsh-composer-height/.test(css), 'chat input is hidden while this tab shows, and no space is reserved for it')
  check(/\.wt-stage \{[^}]*isolation: isolate/.test(css), 'window stack is isolated, so window z-indexes cannot outrank the dialog or menus')
  const dialogZ = Number(/\.wt-scrim \{[^}]*z-index: (\d+)/.exec(css)?.[1])
  const popZ = Number(/\.wt-pop \{[^}]*z-index: (\d+)/.exec(css)?.[1])
  check(dialogZ >= 100 && popZ >= 60, `dialog (${dialogZ}) and menus (${popZ}) have fixed overlay z-indexes`)
  // hammer focus: z-order must stay bounded instead of growing forever
  const [a, b] = qa('.wt-win')
  for (let i = 0; i < 4200; i++) (i % 2 === 0 ? a : b).dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  await sleep(80)
  const zs = qa('.wt-win').map((w) => Number(w.style.zIndex))
  check(Math.max(...zs) < 4100, `z-order stays bounded after thousands of focus changes (max ${Math.max(...zs)})`)
}

// broadcast
click(byText('.wt-bar button', 'Broadcast'))
await sleep(30)
check(qa('.wt-li input[type="checkbox"]').length === 2, 'broadcast shows checkboxes')
const bc = q('.wt-bar2 input.wt-input')
setValue(bc, 'echo hi')
await sleep(40)
await sleep(30)
bc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
await sleep(30)
const got = sockets.filter((s) => s.sent.some((f) => f.type === 'input' && f.data === 'echo hi\r')).length
check(got === 2, `broadcast reached both terminals (${got}/2)`)

// layouts
click(byText('.wt-bar button', 'Layouts'))
await sleep(20)
setValue(q('.wt-pop input'), 'duo')
await sleep(40)
await sleep(30)
click(byText('.wt-pop button', 'Save'))
await sleep(20)
check(byText('.wt-pop .wt-item', 'duo') !== undefined, 'layout saved and listed')

const busyWindow = () => qa('.wt-win').find((w) => w.querySelector('.wt-name')?.textContent === 'Agent A')
// safe close: a busy terminal asks first; Cancel keeps it, OK ends it
let asked = 0
window.confirm = () => { asked++; return false }
click(busyWindow().querySelector('.wt-hbtn[data-danger="true"]'))
await sleep(30)
check(asked === 1 && qa('.wt-win').length === 2, 'closing a busy terminal asks, and Cancel keeps it')
window.confirm = () => { asked++; return true }
click(busyWindow().querySelector('.wt-hbtn[data-danger="true"]'))
await sleep(30)
check(asked === 2 && qa('.wt-win').length === 1, 'confirming ends the terminal and sends a kill frame')
check(sockets.some((x) => x.sent.some((f) => f.type === 'kill')), 'kill frame reached the host')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
