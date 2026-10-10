// SSH terminals, client half: dialog validation, what a window stores (never a secret), Disconnected / Reconnect,
// and the things that must stay off for a remote shell (clickable paths, typed startup commands).
//
//   node --test tests/ssh-client.test.mjs

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
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const attached = (extra = {}) => ({ type: 'attached', created: true, replay: '', exited: false, exitCode: null, agent: null, ...extra })

async function startSsh(ssh = { target: 'me@host.lan', port: 2222, command: 'cd ~/proj && claude' }, extra = {}) {
  const id = s.openTerminal({ ssh, ...extra })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt)
  const sock = await until(() => FakeWebSocket.last, 'the first socket')
  return { id, rt, sock }
}

// ── dialog validation ──

test('resolveSsh: the typed user@host:port wins over a picked alias; errors are readable', () => {
  assert.deepEqual(s.resolveSsh({ alias: 'homepc', quick: '', command: '' }), { ok: true, ssh: { host: 'homepc' } })
  assert.deepEqual(s.resolveSsh({ alias: 'homepc', quick: 'me@10.0.0.2:2200', command: ' ls ' }), { ok: true, ssh: { target: 'me@10.0.0.2', port: 2200, command: 'ls' } })
  assert.deepEqual(s.resolveSsh({ alias: null, quick: 'me@[::1]:22', command: '' }), { ok: true, ssh: { target: 'me@[::1]', port: 22 } })
  for (const quick of ['-oProxyCommand=calc', 'host;calc', 'me@host calc', 'me@host:0', 'me@host:70000', 'me@::1', '@host', 'me@']) {
    const r = s.resolveSsh({ alias: null, quick, command: '' })
    assert.equal(r.ok, false, quick)
    assert.ok(r.error.length > 0)
  }
  assert.equal(s.resolveSsh({ alias: null, quick: '', command: '' }).ok, false, 'nothing picked')
  assert.equal(s.resolveSsh({ alias: '-v', quick: '', command: '' }).ok, false)
  assert.equal(s.resolveSsh({ alias: 'h', quick: '', command: 'a\nb' }).ok, false)
  assert.equal(s.resolveSsh({ alias: 'h', quick: '', command: 'x'.repeat(2049) }).ok, false)
})

test('labels: alias or user@host(:port); default name ssh: <alias or host>', () => {
  assert.equal(s.sshLabel({ host: 'homepc' }), 'homepc')
  assert.equal(s.sshLabel({ target: 'me@host.lan', port: 2222 }), 'me@host.lan:2222')
  assert.equal(s.sshTitle({ host: 'homepc' }), 'ssh: homepc')
  assert.equal(s.sshTitle({ target: 'me@host.lan', port: 2222 }), 'ssh: host.lan')
  assert.deepEqual(s.sshParams({ target: 'me@host.lan', port: 2222, command: 'ls' }), { sshTarget: 'me@host.lan', sshPort: '2222', sshCommand: 'ls' })
})

// ── what is stored ──

test('an ssh window stores the target only; extra fields (a password) never reach storage', async () => {
  const id = s.openTerminal({ ssh: s.cleanSsh({ target: 'me@host.lan', port: '2222', command: 'tmux a', password: 'hunter2', identity: '/k' }), cwd: 'C:\\x', startup: 'claude' })
  const win = s.getWins().find((w) => w.id === id)
  assert.deepEqual(win.ssh, { target: 'me@host.lan', port: 2222, command: 'tmux a' })
  assert.equal(win.shell, 'ssh')
  assert.equal(win.cwd, '', 'no local folder')
  assert.equal(win.startup, undefined, 'the remote command is passed to ssh, not typed')
  assert.equal(win.title, 'ssh: host.lan')
  await sleep(400)
  const stored = window.localStorage.getItem('dsh.web-terminal.layout.v1') + window.localStorage.getItem('dsh.web-terminal.prefs.v1')
  assert.doesNotMatch(stored, /hunter2|password|identity/i)
  const prefs = JSON.parse(window.localStorage.getItem('dsh.web-terminal.prefs.v1'))
  assert.deepEqual(prefs.sshRecents, [win.ssh], 'remembered as a recent target')
  assert.equal(prefs.lastShell, 'default', 'ssh does not become the default shell of the local picker')
})

test('recents keep ten, newest first, deduplicated; favourites toggle', () => {
  for (let i = 0; i < 12; i++) s.noteSsh({ host: `h${i}` })
  s.noteSsh({ host: 'h5' })
  const names = s.getPrefs().sshRecents.map((t) => t.host)
  assert.equal(names.length, 10)
  assert.equal(names[0], 'h5')
  assert.equal(new Set(names).size, 10)
  s.toggleSshFavourite({ host: 'h5' })
  assert.equal(s.getPrefs().sshFavourites.length, 1)
  s.toggleSshFavourite({ host: 'h5' })
  assert.equal(s.getPrefs().sshFavourites.length, 0)
})

test('hydrate re-validates stored targets: a damaged one is dropped, an ssh shell without a target falls back', async () => {
  const f = await loadStore({ fresh: true })
  const base = { x: 0, y: 0, w: 0.5, h: 0.5, z: 1, pinned: false, maximized: false, minimized: false, cwd: '' }
  window.localStorage.setItem('dsh.web-terminal.layout.v1', JSON.stringify({
    wins: [
      { ...base, id: 'ok', title: 'ok', shell: 'ssh', ssh: { host: 'homepc', command: 'ls' } },
      { ...base, id: 'evil', title: 'evil', shell: 'ssh', ssh: { host: '-oProxyCommand=calc' } },
      { ...base, id: 'none', title: 'none', shell: 'ssh' },
    ],
    zTop: 3,
  }))
  window.localStorage.setItem('dsh.web-terminal.prefs.v1', JSON.stringify({ sshRecents: [{ host: 'homepc' }, { target: 'a b' }, 'x'], sshFavourites: [{ target: 'me@h' }] }))
  f.hydrate()
  const byId = Object.fromEntries(f.getWins().map((w) => [w.id, w]))
  assert.deepEqual(byId.ok.ssh, { host: 'homepc', command: 'ls' })
  assert.equal(byId.evil.ssh, undefined)
  assert.equal(byId.evil.shell, 'default')
  assert.equal(byId.none.shell, 'default')
  assert.deepEqual(f.getPrefs().sshRecents, [{ host: 'homepc' }])
  assert.deepEqual(f.getPrefs().sshFavourites, [{ target: 'me@h' }])
  f.closeAll()
})

test('layouts keep the ssh target and reopen it', () => {
  s.openTerminal({ ssh: { host: 'homepc', command: 'ls' } })
  s.saveLayout('remote')
  assert.deepEqual(s.getPrefs().layouts[0].wins[0].ssh, { host: 'homepc', command: 'ls' })
  s.closeAll()
  s.loadLayout('remote')
  const win = s.getWins()[0]
  assert.deepEqual(win.ssh, { host: 'homepc', command: 'ls' })
  assert.equal(win.shell, 'ssh')
})

test('duplicate keeps the target', () => {
  const id = s.openTerminal({ ssh: { host: 'homepc' } })
  s.duplicateWin(id)
  assert.equal(s.getWins().length, 2)
  assert.ok(s.getWins().every((w) => w.ssh?.host === 'homepc' && w.shell === 'ssh'))
})

// ── the socket ──

test('the socket carries the ssh parameters, no folder, and nothing is typed into the session', async () => {
  const { sock } = await startSsh()
  const p = new URL(sock.url).searchParams
  assert.equal(p.get('shell'), 'ssh')
  assert.equal(p.get('sshTarget'), 'me@host.lan')
  assert.equal(p.get('sshPort'), '2222')
  assert.equal(p.get('sshCommand'), 'cd ~/proj && claude')
  assert.equal(p.has('cwd'), false)
  sock.push(attached())
  sock.push({ type: 'data', data: 'Last login\r\n' })
  await sleep(900)
  assert.equal(sock.sent.some((f) => f.type === 'input'), false, 'no startup typing, no --settings: the local settings file does not exist remotely')
})

// ── activity, disconnect, reconnect ──

test('deriveActivity: ssh is Connected while live, never Running; 255 is Disconnected, other codes Exited', () => {
  const base = { agent: undefined, hostBusy: true, ssh: true }
  assert.equal(s.deriveActivity({ ...base, conn: 'live' }), 'connected')
  assert.equal(s.deriveActivity({ ...base, conn: 'connecting' }), 'offline')
  assert.equal(s.deriveActivity({ ...base, conn: 'exited', exitCode: 255 }), 'disconnected')
  assert.equal(s.deriveActivity({ ...base, conn: 'exited', exitCode: 0 }), 'exited')
  assert.equal(s.deriveActivity({ ...base, conn: 'exited', exitCode: 1 }), 'exited')
  assert.equal(s.deriveActivity({ ...base, conn: 'exited', exitCode: null }), 'exited')
  assert.equal(s.deriveActivity({ agent: undefined, hostBusy: true, conn: 'live' }), 'running', 'a local shell is unchanged')
  assert.equal(s.exitAlert(undefined, 255, true).label, 'disconnected')
  assert.equal(s.exitAlert(undefined, 255, false).label, 'exited')
})

test('exit 255 shows Disconnected; Reconnect spawns again with the same target, once', async () => {
  const { id, rt, sock } = await startSsh()
  sock.push(attached())
  sock.push({ type: 'activity', busy: true })
  await sleep(30)
  assert.equal(rt.activity, 'connected')
  sock.push({ type: 'exit', exitCode: 255 })
  await sleep(30)
  assert.equal(rt.conn, 'exited')
  assert.equal(rt.activity, 'disconnected')
  await sleep(500)
  assert.equal(FakeWebSocket.instances.length, 1, 'no automatic reconnect')
  s.restartWin(id)
  s.ensureRuntime(s.getWins().find((w) => w.id === id)) // the view does this when the window re-renders
  const next = await until(() => (FakeWebSocket.last !== sock ? FakeWebSocket.last : undefined), 'the reconnect socket')
  const a = new URL(sock.url).searchParams
  const b = new URL(next.url).searchParams
  assert.notEqual(a.get('id'), b.get('id'), 'a new generation, so the host never confuses it with the old session')
  for (const key of ['shell', 'sshTarget', 'sshPort', 'sshCommand']) assert.equal(b.get(key), a.get(key), key)
  assert.equal(FakeWebSocket.instances.length, 2)
})

test('another exit code is a normal end', async () => {
  const { rt, sock } = await startSsh({ host: 'homepc' })
  sock.push(attached())
  sock.push({ type: 'exit', exitCode: 0 })
  await sleep(30)
  assert.equal(rt.activity, 'exited')
})

test('a reattach to a session that already ended with 255 is Disconnected too', async () => {
  const { rt, sock } = await startSsh({ host: 'homepc' })
  sock.push(attached({ created: false, exited: true, exitCode: 255 }))
  await sleep(30)
  assert.equal(rt.activity, 'disconnected')
})

test('the host refusing an ssh request is a failure with Restart, not a blank window', async () => {
  const { rt, sock } = await startSsh({ host: 'homepc' })
  sock.push({ type: 'error', message: 'could not start ssh: nope' })
  await sleep(30)
  assert.equal(rt.conn, 'failed')
})

// ── clickable paths ──

test('clickable paths are registered for local windows and skipped for ssh windows', async () => {
  const runtimeOf = (id) => s.ensureRuntime(s.getWins().find((w) => w.id === id))
  const local = runtimeOf(s.openTerminal({ cwd: 'C:\\x' }))
  const remote = runtimeOf(s.openTerminal({ ssh: { host: 'homepc' } }))
  let localProviders = 0
  let remoteProviders = 0
  local.term.registerLinkProvider = () => { localProviders++; return { dispose() {} } }
  remote.term.registerLinkProvider = () => { remoteProviders++; return { dispose() {} } }
  s.registerPathLinks(local)
  s.registerPathLinks(remote)
  assert.equal(localProviders, 1)
  assert.equal(remoteProviders, 0)
})
