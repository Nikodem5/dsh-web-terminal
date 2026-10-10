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
  pathToFileURL(join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', 'package.json')).href,
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
// The host probe is slow on a cold start (it looks shells up on PATH): answer after the terminal attaches.
const statsPayload = { ok: true, limits: { fiveHour: { usedPct: 42, resetsAt: Date.now() + 3600e3, outAt: Date.now() + 1800e3 }, sevenDay: { usedPct: 63, resetsAt: Date.now() + 86400e3, outAt: null }, sampledAt: Date.now() }, cost: { totalUsd: 12.34, terminals: 2 }, tokens: { total: 2_500_000_000, input: 1, output: 2, cacheRead: 3, cacheCreation: 4, asOf: Date.now() }, statusLine: { enabled: true, reason: null } }
const infoFetch = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => ({ ok: true, json: async () => ({ version: '9.9.9', node: { available: true, path: 'C:\node\node.exe' }, shells: [{ id: 'powershell', label: 'PowerShell' }], cwd: 'C:\\Users\\me', claude: { available: true }, agent: { claudeSettings: 'C:\\Users\\me\\.dsh\\web-terminal\\claude-settings-1.json' }, sessions: [] }) }))
window.fetch = (url) => (String(url).endsWith('/stats') ? Promise.resolve({ ok: true, json: async () => statsPayload }) : infoFetch())
window.confirm = () => true
window.__DSH_TRANSPORT__ = { streamBaseUrl: 'http://127.0.0.1:19387' }
window.HTMLCanvasElement.prototype.getContext = () => null
// jsdom has no IE-era event API, which React probes when an input takes focus.
window.Element.prototype.attachEvent = () => {}
window.Element.prototype.detachEvent = () => {}
window.Element.prototype.setPointerCapture = () => {}
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
let statsBar
let statsOptions
let panelEntry
let mainKey
exportsObject.apply({
  slots: {
    inject: (_key, cb) => { cb(); return () => {} },
    register: (options, comp) => {
      if (options.name === 'conversation.session.header.utilities') { statsBar = comp; statsOptions = options; return () => {} }
      if (options.name === 'sidebar.panellist') { panelEntry = options; return () => {} }
      if (options.name === 'main') { component = comp; mainKey = options.key }
      return () => {}
    },
  },
  sessions: { list: { getSnapshot: () => ({ byId: { s1: { cwd: 'C:\\work\\repo' } } }) } },
})
check(panelEntry?.label() === 'Terminals' && panelEntry.id === mainKey, 'the sidebar entry is labelled Terminals and shares the main key')
const barProps = statsOptions.inject('s1')
check(barProps.sessionCwd() === 'C:\\work\\repo', 'the header bar is injected with the session workspace folder')
// The shell hands every main entry its standard hooks; this is the workspaces one.
let workspaceItems = [
  { workspaceId: 'w1', title: 'deepseek-harness-1', path: '/w/deepseek-harness-1', sessionIds: [] },
  { workspaceId: 'w2', title: 'notes', path: '/w/notes', sessionIds: [] },
]
const props = { useWorkspaces: (select) => select({ items: workspaceItems, phase: 'ready' }) }

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
const wsChips = qa('.wt-dialog .wt-chip').filter((el) => workspaceItems.some((w) => w.title === el.textContent))
check(wsChips.length === 2 && q('.wt-dialog').textContent.includes('Workspaces:'), 'the dialog offers the harness Workspaces as chips')
check(!q('.wt-dialog').textContent.includes('last session'), 'no last-session fallback while Workspaces are listed')
click(wsChips[1])
await sleep(20)
check(q('.wt-dialog input').value === '/w/notes', 'clicking a Workspace chip fills the folder')
setValue(q('.wt-dialog input'), 'C:\\work\\repo')
await sleep(40)
// Enter on a button presses that button; it must not also open the terminal.
byText('.wt-dialog button', 'Cancel').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
await sleep(20)
check(q('.wt-dialog') !== null && qa('.wt-win').length === 0, 'Enter on the Cancel button does not open a terminal')
click(byText('.wt-dialog button', 'claude --resume'))
await sleep(40)
click(byText('.wt-dialog button', 'Open'))
await sleep(120)
check(qa('.wt-win').length === 1, 'a terminal window opens')
const sock = sockets[sockets.length - 1]
check(sock.url.startsWith('ws://127.0.0.1:19387/terminal/ws?') && sock.url.includes('cwd=C%3A%5Cwork%5Crepo'), 'socket targets the host origin with the chosen folder')

// host attaches a fresh shell: startup command is typed once its prompt is up

sock.push({ type: 'attached', created: true, replay: '', exited: false, exitCode: null })
sock.push({ type: 'data', data: 'PS C:/work/repo> ' })
await sleep(1700)
check(
  sock.sent.some((f) => f.type === 'input' && f.data === 'claude --settings "C:/Users/me/.dsh/web-terminal/claude-settings-1.json" --resume\r'),
  'startup command waits for a slow host probe, then is typed with the agent hooks added to claude',
)

// Claude-style title becomes the default name
sock.push({ type: 'data', data: '\x1b]0;\u2733 Fix login bug\x07' })
await sleep(150)
check(q('.wt-li-name')?.textContent === 'Fix login bug', `list shows the Claude session name (got "${q('.wt-li-name')?.textContent}")`)

// status comes from facts and agent signals, never from guessing at output.
// The app is in the background here, so flags are raised (a watched terminal gets none: tested below).
window.document.hasFocus = () => false
const dot = () => q('.wt-li .wt-dot')?.dataset.a
sock.push({ type: 'data', data: 'compiling…\r\n' })
await sleep(1200)
check(dot() === 'idle', `output alone does not make a terminal look busy (got ${dot()})`)
sock.push({ type: 'activity', busy: true })
await sleep(60)
check(dot() === 'running', `a program under the shell shows Running (got ${dot()})`)
sock.push({ type: 'agent', provider: 'claude', state: 'working', detail: '' })
await sleep(60)
check(dot() === 'working', `an agent working signal shows Working (got ${dot()})`)
check(q('.wt-li .wt-badge') === null, 'working raises no flag')
sock.push({ type: 'agent', provider: 'claude', state: 'needs-you', detail: 'Permission: Bash: npm test' })
await sleep(60)
check(dot() === 'needs-you', `a permission request shows Needs you (got ${dot()})`)
check(q('.wt-li .wt-badge') !== null, 'the list row gets a flag')
check(q('.wt-win .wt-badge')?.textContent === 'needs you' && q('.wt-win .wt-badge')?.dataset.level === 'urgent', 'the window badge says needs you, urgent')
check((q('.wt-win .wt-badge')?.title ?? '').includes('Permission: Bash: npm test'), 'the badge tooltip carries the agent detail')
check(q('.wt-li-sub')?.textContent.startsWith('Needs you'), 'the list row reads Needs you')
sock.push({ type: 'agent', provider: 'claude', state: 'working', detail: '' })
await sleep(60)
check(q('.wt-li .wt-badge') === null && dot() === 'working', 'the next working signal clears the flag')
sock.push({ type: 'agent', provider: 'claude', state: 'finished', detail: '' })
await sleep(60)
check(dot() === 'finished' && q('.wt-win .wt-badge')?.dataset.level === 'quiet', 'a finished turn shows Finished with a quiet flag')
sock.push({ type: 'agent', provider: 'claude', state: 'ended', detail: '' })
await sleep(60)
check(dot() === 'running', `after the agent ends the plain-shell facts show again (got ${dot()})`)

// a terminal the user is looking at is not flagged (the dot still follows the agent)
window.document.hasFocus = () => true
sock.push({ type: 'agent', provider: 'claude', state: 'working', detail: '' })
sock.push({ type: 'agent', provider: 'claude', state: 'needs-you', detail: 'Permission: Edit: a.ts' })
await sleep(60)
check(dot() === 'needs-you' && q('.wt-li .wt-badge') === null, 'a terminal in front of the user shows Needs you but raises no flag')
sock.push({ type: 'agent', provider: 'claude', state: 'ended', detail: '' })
await sleep(60)

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

// Escape cancels a rename instead of saving it (sidebar and window title)
{
  q('.wt-li-name').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  await sleep(20)
  const edit = q('.wt-li input.wt-name-input')
  setValue(edit, 'Discarded')
  edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  edit.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }))
  await sleep(30)
  check(q('.wt-li input.wt-name-input') === null && q('.wt-li-name')?.textContent === 'Agent A', `Escape cancels a sidebar rename (got "${q('.wt-li-name')?.textContent}")`)
  click(q('.wt-win .wt-name'))
  await sleep(20)
  const head = q('.wt-win input.wt-name-input')
  setValue(head, 'Discarded')
  head.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  head.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }))
  await sleep(30)
  check(q('.wt-win input.wt-name-input') === null && q('.wt-win .wt-name')?.textContent === 'Agent A', `Escape cancels a title-bar rename (got "${q('.wt-win .wt-name')?.textContent}")`)
}

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

// output to a terminal that is not in front leaves a subtle unread count in its list row
{
  window.document.hasFocus = () => true
  const row = () => q('.wt-li[data-focused="false"]') // the first terminal: the new one has focus
  check(row()?.querySelector('.wt-unread') === null, 'no unread indicator before any output')
  sock.push({ type: 'data', data: 'a\r\nb\r\nc\r\n' })
  await sleep(120)
  const mark = row()?.querySelector('.wt-unread')
  check(mark?.textContent === '3' && row()?.querySelector('.wt-badge') === null, `an unfocused terminal shows 3 unread lines, apart from attention badges (got "${mark?.textContent}")`)
  click(row())
  await sleep(60)
  check(row()?.querySelector('.wt-unread') === null, 'looking at the terminal clears the list indicator')
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

// bigger default font, and the settings menu shows it
{
  click(byText('.wt-bar button', 'Aa'))
  await sleep(30)
  const numbers = qa('.wt-pop input[type="number"]').map((i) => i.value)
  check(q('.wt-pop select')?.value === 'dark', 'terminal colours default to dark')
  check(q('.wt-view').style.getPropertyValue('--wt-term-bg') === '#14161b', 'window chrome matches the terminal background')
  check(numbers[0] === '14', `default terminal font size is 14 (got ${numbers[0]})`)
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
  check(!/composerSeat/.test(css) && /\[data-platform="darwin"\] \.wt-page[^}]*--dsh-frame-top-clearance/.test(css), 'no chat-composer hack any more; the page pads its top by the frame clearance on macOS')
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

// dragging a maximized window into the full-screen zone keeps the pre-maximize size as its restore size
{
  const win = qa('.wt-win')[0]
  const head = win.querySelector('.wt-head')
  const before = win.style.width
  head.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  await sleep(30)
  const full = win.style.width
  check(full !== before, `double-click maximizes (${before} -> ${full})`)
  const pointer = (type, x, y) => head.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
  pointer('pointerdown', 300, 10)
  pointer('pointermove', 320, 60)
  pointer('pointermove', 400, 0)
  pointer('pointerup', 400, 0)
  await sleep(30)
  check(win.style.width === full, 'dropping on the top edge maximizes again')
  click(win.querySelector('.wt-hbtn[title="Restore"]'))
  await sleep(30)
  check(win.style.width === before, `restore returns to the old size, not full screen (${win.style.width} vs ${before})`)
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

// stats bar: a second root, as another session header would mount it
check(statsOptions?.id === 'terminal-stats' && statsOptions.order === 10, 'the stats bar registers into the header utilities seat')
const barHost = doc.createElement('div')
doc.body.appendChild(barHost)
const barRoot = ReactDOMClient.createRoot(barHost)
sock.push({ type: 'agent', provider: 'claude', state: 'working', detail: '' })
await sleep(40)
ReactDOM.flushSync(() => barRoot.render(React.createElement(statsBar, barProps)))
await sleep(60)
const pageBar = q('.wt-view .wt-statsrow .wt-stats')
check(pageBar !== null && pageBar.textContent.includes('5h 42%') && pageBar.textContent.includes('$12.34'), 'the stats bar also renders in the page toolbar')
check(pageBar?.textContent.includes('1 working') === true, 'the page bar counts agents live too (two bars share the poller)')
const barText = barHost.textContent
check(barText.includes('5h 42%') && barText.includes('7d 63%') && barText.includes('out ~'), `stats bar shows limits (${barText})`)
check(barText.includes('$12.34') && barText.includes('2.5B tok'), 'stats bar shows cost and tokens')
check(barText.includes('1 working'), 'stats bar counts a working agent')
check(barHost.querySelectorAll('.wt-pct').length === 2 && barHost.querySelectorAll('.wt-pct-warn').length === 1 && barHost.querySelector('.wt-pct-danger') === null, 'stats bar colours only the 63% percentage (warn), not 42%')
sock.push({ type: 'agent', provider: 'claude', state: 'needs-you', detail: 'Permission: Bash: ls' })
await sleep(60)
check(barHost.textContent.includes('1 needs you') && !barHost.textContent.includes('working'), 'agent counts update live without a re-render')
sock.push({ type: 'agent', provider: 'claude', state: 'ended', detail: '' })
await sleep(60)
check(barHost.querySelector('.wt-stats-warn') !== null, 'out time is highlighted')
ReactDOM.flushSync(() => barRoot.unmount())
barHost.remove()
check(q('.wt-view .wt-statsrow .wt-stats') !== null, 'unmounting the header bar leaves the page bar running')

// sub-agents: panel toggle, grouped rows from a frame, count in the stats bar
check(q('.wt-agents') === null, 'the sub-agents panel starts closed')
sock.push({ type: 'subagents', tasks: [
  { id: 'a1', agentType: 'Explore', label: 'Find callers', description: 'd', status: 'running', model: 'claude-haiku-5-5', startTime: Date.now() - 65_000, endedAt: null, tokenCount: 12_300, contextWindowSize: 200000 },
  { id: 'a2', agentType: 'Plan', label: '', description: 'Old plan', status: 'completed', model: null, startTime: Date.now() - 90_000, endedAt: Date.now() - 30_000, tokenCount: null, contextWindowSize: null },
] })
await sleep(60)
const agentsBtn = byText('.wt-bar button', 'Agents')
check(agentsBtn.textContent.includes('1'), 'the Agents button badges the running count')
click(agentsBtn)
await sleep(40)
const rows = qa('.wt-agents-row')
check(q('.wt-agents') !== null && rows.length === 2, `the panel lists both sub-agents (${rows.length})`)
check(qa('.wt-agents-head').length === 1, 'one group per terminal')
check(rows[0].textContent.includes('Find callers') && rows[0].textContent.includes('haiku-5-5') && rows[0].textContent.includes('12.3k tok') && rows[0].textContent.includes('Explore'), `running row shows label, model, tokens, type (${rows[0].textContent})`)
check(/1m 0\ds/.test(rows[0].textContent), 'running row shows elapsed time')
check(rows[1].textContent.includes('Old plan') && rows[1].dataset.running === 'false' && rows[1].textContent.includes('1m 00s'), 'completed row is dimmed with its total time')
sock.push({ type: 'subagents', tasks: [{ id: 'a1', agentType: 'Explore', label: 'Find callers', status: 'running' }, { id: 'a3', agentType: 'Plan', label: 'Second', status: 'running' }] })
await sleep(60)
check(q('.wt-view .wt-statsrow .wt-stats')?.textContent.includes('2 agents') === true, 'the stats bar shows 2 agents')
sock.push({ type: 'subagents', tasks: [] })
await sleep(60)
check(q('.wt-agents').textContent.includes('No sub-agents running') && !q('.wt-view .wt-statsrow .wt-stats').textContent.includes('agents'), 'empty state, and the count is hidden at 0')
click(byText('.wt-bar button', 'Agents'))
await sleep(40)
check(q('.wt-agents') === null, 'the Agents button closes the panel')

// toolbar stability: it is a full-width row above the columns, outside the shrinking area, and toggling panels never touches it
{
  const toolbarShape = () => {
    const bar = q('.wt-page > .wt-bar')
    return bar === null ? null : q('.wt-statsrow').children.length + [...bar.children].map((r) => r.className + ':' + [...r.children].map((c) => c.className.split(' ').slice(0, 2).join('.')).join(',')).join('|')
  }
  const bar = q('.wt-page > .wt-bar')
  check(bar !== null && bar.closest('.wt-main') === null && bar.closest('.wt-cols') === null, 'the toolbar sits outside the columns and the shrinking main area')
  const row2 = q('.wt-page > .wt-statsrow')
  check(bar.nextElementSibling === row2 && row2.nextElementSibling === q('.wt-cols') && q('.wt-cols > .wt-main') !== null, 'the stats row sits between the toolbar and the columns')
  check(row2.querySelector('.wt-stats') !== null && row2.closest('.wt-cols') === null && bar.querySelector('.wt-stats') === null, 'the stats bar lives in row 2, outside the columns')
  check([...bar.children].map((c) => c.className).join() === 'wt-bar-left,wt-bar-mid,wt-bar-right', 'toolbar = left | middle | right regions')
  check(byText('.wt-bar button', 'Claude').classList.contains('wt-btn-claude') && byText('.wt-bar button', 'Agents').classList.contains('wt-btn-agents'), 'Claude and Agents buttons carry their own classes')
  const before = toolbarShape()
  const sidebarOpen = q('.wt-side') !== null
  click(byText('.wt-bar button', '☰'))
  await sleep(30)
  check((q('.wt-side') !== null) !== sidebarOpen && toolbarShape() === before, 'toggling the terminal list does not change the toolbar structure')
  click(byText('.wt-bar button', '☰'))
  await sleep(30)
  click(byText('.wt-bar button', 'Agents'))
  await sleep(30)
  check(q('.wt-agents') !== null && toolbarShape() === before && q('.wt-page > .wt-bar') === bar, 'opening the Agents panel keeps the same toolbar node and structure')
  click(byText('.wt-bar button', 'Agents'))
  await sleep(30)
}

// No Workspaces from the shell: the dialog falls back to the folder of the session last viewed in the chat header.
workspaceItems = []
render()
await sleep(30)
click(byText('.wt-bar button', 'New terminal'))
await sleep(20)
setValue(q('.wt-dialog input'), '/elsewhere')
await sleep(20)
check(!q('.wt-dialog').textContent.includes('Workspaces:'), 'no Workspaces row when the shell lists none')
const lastSession = byText('.wt-dialog .wt-chip', 'last session')
check(lastSession !== undefined, 'the dialog offers the last session workspace instead')
click(lastSession)
await sleep(20)
check(q('.wt-dialog input').value === 'C:\\work\\repo', 'the fallback chip fills the recorded session folder')
click(byText('.wt-dialog button', 'Cancel'))
await sleep(20)

// ── send the selection to another terminal ──
{
  // jsdom has no layout: give every element a fixed box so xterm measures a cell and a drag can select.
  const orig = window.Element.prototype.getBoundingClientRect
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 320, width: 640, height: 320, x: 0, y: 0 })
  // xterm measures a cell from the offset size of a 32-character probe.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get() { return 640 }, configurable: true })
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', { get() { return 320 }, configurable: true })
  click(byText('.wt-bar button', 'New terminal'))
  await sleep(20)
  setValue(q('.wt-dialog input'), 'C:\\build')
  click(byText('.wt-dialog button', 'Open'))
  await sleep(60)
  // Agent A (the first terminal) is a Claude with bracketed paste on, as its prompt would have it.
  sock.push({ type: 'agent', provider: 'claude', state: 'finished', detail: '' })
  sock.push({ type: 'data', data: '\x1b[?2004h' })
  const bsock = sockets[sockets.length - 1]
  bsock.push({ type: 'attached', created: false, replay: '', exited: false, exitCode: null })
  bsock.push({ type: 'data', data: 'TS2304 no name x' })
  await sleep(100)
  const win = qa('.wt-win')[0]
  const screen = win.querySelector('.xterm-screen')
  const mouse = (target, type, x, y, extra = {}) => target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, detail: 1, ...extra }))
  const rightClick = () => {
    const e = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 20, button: 2 })
    win.querySelector('.wt-holder').dispatchEvent(e)
    return e
  }
  check(!rightClick().defaultPrevented && q('.wt-send') === null, 'right-click without a selection keeps the default behaviour')
  mouse(screen, 'mousedown', 1, 1)
  mouse(screen, 'mousemove', 400, 1)
  window.document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 400, clientY: 1 }))
  await sleep(30)
  const prevented = rightClick().defaultPrevented
  await sleep(30)
  check(prevented && q('.wt-send') !== null, 'right-click on a selection opens the Send to menu')
  window.Element.prototype.getBoundingClientRect = orig
  const labels = qa('.wt-send .wt-send-item').map((el) => el.textContent)
  check(labels[0] === 'Copy' && labels.some((l) => l.includes('Agent A')) && labels[labels.length - 1].includes('New Claude terminal'), `the menu lists Copy, the other terminals and a new Claude terminal (${labels.join(' | ')})`)
  check(q('.wt-send .wt-send-item[data-active="true"]')?.textContent.includes('Agent A'), 'the agent terminal is preselected')
  q('.wt-send').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(40)
  const agentSock = sockets.find((x) => x.sent.some((f) => f.type === 'input' && f.data.includes('[200~')))
  check(q('.wt-send') === null && agentSock !== undefined && agentSock !== bsock, 'Enter sends the selection to the chosen terminal only')
  check(!bsock.sent.some((f) => f.type === 'input'), 'nothing is typed into the source terminal')
  check(q('.wt-win[data-focused="true"] .wt-name')?.textContent === 'Agent A', 'the target window is focused')
  check(agentSock !== undefined && agentSock.sent.filter((f) => f.type === 'input').pop().data.endsWith('~'), 'the text arrives as a bracketed paste in a code block, without Enter')
  // Escape cancels the picker.
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 320, width: 640, height: 320, x: 0, y: 0 })
  mouse(screen, 'mousedown', 1, 1)
  mouse(screen, 'mousemove', 400, 1)
  window.document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, clientX: 400, clientY: 1 }))
  await sleep(30)
  rightClick()
  await sleep(30)
  q('.wt-send')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(30)
  check(q('.wt-send') === null, 'Escape closes the Send to menu')
  window.Element.prototype.getBoundingClientRect = orig
  sock.push({ type: 'data', data: '\x1b[?2004l' })
  sock.push({ type: 'agent', provider: 'claude', state: 'ended', detail: '' })
  // Remove the extra terminal so the checks below see the original two.
  window.confirm = () => true
  click(win.querySelector('.wt-hbtn[data-danger="true"]'))
}

  await sleep(40)
// mission control: a pure view transform, never a resize or a layout change
{
  const winShape = () => qa('.wt-win').map((w) => [w.style.left, w.style.top, w.style.width, w.style.height, w.style.zIndex, w.style.display].join(','))
  const resizes = () => sockets.reduce((n, x) => n + x.sent.filter((f) => f.type === 'resize').length, 0)
  const stored = () => window.localStorage.getItem('dsh.web-terminal.layout.v1')
  const winNamed = (name) => qa('.wt-win').find((w) => w.querySelector('.wt-name')?.textContent === name)
  const key = (init) => window.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  const other = qa('.wt-win').find((w) => w.querySelector('.wt-name')?.textContent !== 'Agent A')
  const otherName = other.querySelector('.wt-name').textContent
  click(other.querySelector('.wt-hbtn[title="Minimize"]'))
  await sleep(30)
  check(winNamed(otherName).style.display === 'none', 'overview setup: one window is minimized')
  winNamed('Agent A').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  await sleep(400)
  const saved = stored()
  const resizeBefore = resizes()

  click(byText('.wt-bar button', 'Overview'))
  await sleep(30)
  check(q('.wt-mission') !== null && qa('.wt-tile').length === 2, 'Overview shows a tile per terminal, minimized ones included')
  check(qa('.wt-win').every((w) => w.style.display === 'flex' && /scale\(/.test(w.style.transform)), 'every window, minimized too, is CSS-scaled into its tile')
  await sleep(400)
  check(resizes() === resizeBefore && stored() === saved, 'overview sends no resize frame and persists no layout')

  // typing filters the tiles; the non-matching window is hidden
  key({ key: otherName[0].toLowerCase() })
  key({ key: otherName[1].toLowerCase() })
  await sleep(20)
  check(qa('.wt-tile').length === 1 && q('.wt-mission-filter') !== null, 'typing filters the tiles by name')
  check(winNamed('Agent A').style.visibility === 'hidden', 'a filtered-out window is hidden')
  key({ key: 'Enter' })
  await sleep(60)
  check(q('.wt-mission') === null && winNamed(otherName).style.display === 'flex' && winNamed(otherName).dataset.focused === 'true', 'Enter on a filtered tile leaves overview, restores and focuses that terminal')
  check(qa('.wt-win').every((w) => w.style.transform === ''), 'leaving overview clears the scaling')
  await sleep(400)
  check(resizes() === resizeBefore, 'leaving overview sends no resize frame either')

  // minimize it again, refocus Agent A, then Esc must change nothing
  click(winNamed(otherName).querySelector('.wt-hbtn[title="Minimize"]'))
  await sleep(30)
  winNamed('Agent A').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  await sleep(400)
  const shape2 = winShape()
  const saved2 = stored()
  key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true })
  await sleep(20)
  check(q('.wt-mission') !== null, 'Ctrl+Shift+Space opens overview')
  key({ key: 'ArrowRight' })
  await sleep(20)
  check(qa('.wt-tile[data-sel="true"]').length === 1, 'arrow keys move one selected tile')
  key({ key: 'Escape' })
  await sleep(60)
  check(q('.wt-mission') === null && winShape().join('|') === shape2.join('|') && stored() === saved2, 'Esc restores every window rect, z and minimized state exactly')
  check(winNamed('Agent A').dataset.focused === 'true' && winNamed(otherName).style.display === 'none', 'Esc leaves focus and minimized state unchanged')
  check(resizes() === resizeBefore, 'overview never resized a terminal')
  click(byText('.wt-chip', otherName))
  await sleep(30)
}

// help panel: the book button, sections, filter, Esc, F1
{
  const btn = q('.wt-bar-right button[title="Help"]')
  check(btn !== null && btn.querySelector('svg') !== null && btn.closest('.wt-bar-right') === btn.closest('.wt-bar').querySelector('.wt-bar-right'), 'the Help button (book icon) sits in the right-hand toolbar group')
  check(q('.wt-help') === null, 'the help panel starts closed')
  click(btn)
  await sleep(40)
  check(q('.wt-help') !== null, 'the Help button opens the panel')
  check(qa('.wt-help-sec h4').map((h) => h.textContent).join('|') === 'Keyboard shortcuts|Mouse|Status colours|Stats bar|Diagnostics', 'all five sections render')
  const total = qa('.wt-help [data-shortcut]').length
  check(total >= 15 && qa('.wt-help-group').length >= 7, 'shortcuts are listed in groups')
  check(qa('.wt-help .wt-dot').map((d) => d.dataset.a).join(',') === 'working,needs-you,finished,running,idle,exited,offline', 'the legend draws every status dot with the real .wt-dot classes')
  check(q('.wt-help .wt-badge[data-level="urgent"]') !== null && q('.wt-help .wt-badge[data-level="quiet"]') !== null && qa('.wt-help .wt-gutter-swatch').length === 4, 'badge and command-bar legends render')
  const diag = q('.wt-help-sec:last-child').textContent
  check(diag.includes('9.9.9') && diag.includes('C:\node\node.exe') && /Terminals.*live/.test(diag) && diag.includes('Status-line wrapper'), 'diagnostics show the live version, node path and terminal counts')
  setValue(q('.wt-help input'), 'unread')
  await sleep(30)
  const left = qa('.wt-help [data-shortcut]').map((r) => r.dataset.shortcut)
  check(left.length === 1 && left[0] === 'unread', 'the filter narrows the shortcut list')
  setValue(q('.wt-help input'), 'zzzz')
  await sleep(30)
  check(qa('.wt-help [data-shortcut]').length === 0 && q('.wt-help').textContent.includes('No shortcut matches'), 'an unmatched filter says so')
  doc.defaultView.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await sleep(30)
  check(q('.wt-help') === null, 'Esc closes the help panel')
  doc.defaultView.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }))
  await sleep(30)
  check(q('.wt-help') !== null, 'F1 opens the help panel')
  doc.defaultView.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }))
  await sleep(30)
  check(q('.wt-help') === null, 'F1 again closes it')
}

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
