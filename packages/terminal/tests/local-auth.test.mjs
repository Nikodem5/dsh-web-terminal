// Access control for the plugin's routes and socket: a loopback peer, a loopback Host and the per-boot
// token are all required, whatever the Origin header says (or omits).

import { listenLocal } from '../../shared/test/listen.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { setSpawnForTests } from '../lib/open.js'
import { TOKEN_GLOBAL, bootToken, checkAccess, exposeToken, isLoopbackAddress, isLoopbackHostHeader } from '../lib/shared/local-auth.js'
import { authHeaders, localReq } from './helpers/local-auth.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-auth-'))
process.env.DSH_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers: { host: '127.0.0.1:3081', ...headers }, socket: { remoteAddress } })
const bearer = () => ({ authorization: `Bearer ${bootToken()}` })

test('loopback address and Host recognition', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a)
  for (const a of ['10.0.0.5', '192.168.1.2', '::ffff:10.0.0.5', '2001:db8::1', '', undefined, null]) assert.equal(isLoopbackAddress(a), false, String(a))
  for (const h of ['127.0.0.1:3081', 'localhost', 'LOCALHOST:80', '[::1]:3081']) assert.equal(isLoopbackHostHeader(h), true, h)
  for (const h of ['evil.example', 'evil.example:3081', '127.0.0.1.evil.example', 'localhost.evil.example', '', undefined, 'a b']) assert.equal(isLoopbackHostHeader(h), false, String(h))
})

test('checkAccess: only a local, token-bearing request passes', () => {
  assert.deepEqual(checkAccess(req(bearer())), { ok: true })
  // The reported hole: no Origin and no credential at all.
  assert.equal(checkAccess(req()).status, 401)
  assert.equal(checkAccess(req({ authorization: 'Bearer nope' })).status, 401)
  assert.equal(checkAccess(req({ authorization: bootToken() })).status, 401, 'scheme required')
  // A non-loopback peer is refused even with the token.
  const remote = checkAccess(req(bearer(), '203.0.113.9'))
  assert.equal(remote.status, 403)
  assert.equal(remote.code, 'remote')
  assert.equal(checkAccess({ headers: bearer() }).status, 403, 'no socket at all')
  // A tunnel or proxy on this machine connects from loopback but arrives under a public name.
  assert.equal(checkAccess(req({ ...bearer(), host: 'abc.trycloudflare.com' })).code, 'host')
  // A foreign page is refused even if it somehow had the token.
  assert.equal(checkAccess(req({ ...bearer(), origin: 'https://evil.example' })).code, 'origin')
  // The extra-origins setting never lifts the loopback rules.
  assert.equal(checkAccess(req({ ...bearer(), host: 'harness.example', origin: 'https://harness.example' }), ['https://harness.example']).code, 'host')
  // The WebSocket form of the token.
  assert.equal(checkAccess(req({ 'sec-websocket-protocol': `dsh-wt, dsh-wt.${bootToken()}` })).ok, true)
  assert.equal(checkAccess(req({ 'sec-websocket-protocol': 'dsh-wt, dsh-wt.wrong' })).status, 401)
})

test('exposeToken puts the token into the served page', () => {
  let listener
  const ctx = { on: (event, fn) => { assert.equal(event, 'webserver/index-inject'); listener = fn; return () => {} } }
  exposeToken(ctx)
  const table = []
  listener(table)
  assert.deepEqual(table, [{ kind: 'global', name: TOKEN_GLOBAL, value: bootToken() }])
})

/** Apply the plugin with fake services; returns the routes, the upgrade handler and the programs spawned. */
function start() {
  const routes = []
  const upgrades = []
  const launched = []
  setSpawnForTests((...args) => {
    launched.push(args)
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  let teardown
  apply({
    on: () => () => {},
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
      registerUpgrade: (route) => { upgrades.push(route); return () => {} },
    },
    subprocess: { spawnTerminal: async () => { throw new Error('no shell expected') } },
    effect: (fn) => { teardown = fn() },
  })
  after(() => { teardown?.(); setSpawnForTests(undefined) })
  return { routes, upgrades, launched }
}

/** Call a JSON route with a fake request; resolves { status, body }. */
function call(routes, path, request, body) {
  return new Promise((resolve) => {
    const fake = Object.assign(new EventEmitter(), request)
    const res = {
      writeHead(status) { this.status = status },
      end(payload) { resolve({ status: this.status, body: payload === undefined ? undefined : JSON.parse(payload) }) },
    }
    routes.find((r) => r.path === path).handler(fake, res)
    queueMicrotask(() => {
      if (body !== undefined) fake.emit('data', Buffer.from(JSON.stringify(body)))
      fake.emit('end')
    })
  })
}

test('every HTTP route refuses a request without the token, and /open spawns nothing', async () => {
  const { routes, launched } = start()
  const file = join(home, 'victim.txt')
  writeFileSync(file, 'x')
  const attack = { path: file, target: 'custom', template: 'cmd /c calc.exe {file}' }
  const bare = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3081' } }
  const paths = routes.map((r) => r.path)
  for (const expected of ['info', 'stats', 'paths', 'open', 'update', 'relaunch']) assert.ok(paths.includes(`/api/dsh-web-terminal/${expected}`), expected)
  for (const path of paths) {
    const refused = await call(routes, path, bare, attack)
    assert.equal(refused.status, 401, path)
    assert.equal(refused.body.ok, false, path)
  }
  assert.deepEqual(launched, [], 'nothing was launched')
  // From a remote peer the token does not help either.
  const remote = { ...localReq({ method: 'POST' }), socket: { remoteAddress: '198.51.100.7' } }
  assert.equal((await call(routes, '/api/dsh-web-terminal/open', remote, attack)).status, 403)
  assert.deepEqual(launched, [])
  // The legitimate client still works.
  const ok = await call(routes, '/api/dsh-web-terminal/open', localReq({ method: 'POST' }), { path: file, target: 'custom', template: 'viewer {file}' })
  assert.equal(ok.status, 200)
  assert.equal(launched.length, 1)
})

test('upgrade: no token, a wrong token or a remote peer never reaches the handshake; a token in the subprotocol does', async () => {
  const { upgrades } = start()
  const upgrade = upgrades.find((u) => u.path === '/terminal/ws')
  const http = createServer()
  http.on('upgrade', (request, socket, head) => upgrade.handler(request, socket, head))
  await listenLocal(http)
  after(() => http.close())
  const url = `ws://127.0.0.1:${http.address().port}/terminal/ws?id=auth-${Date.now()}&shell=cmd&cols=80&rows=24`
  const status = (protocols, options) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, protocols, options)
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode) })
      ws.on('open', () => { ws.terminate(); resolve(101) })
      ws.on('error', () => {})
    })
  assert.equal(await status(undefined), 401)
  assert.equal(await status(['dsh-wt', 'dsh-wt.wrong']), 401)
  assert.equal(await status(['dsh-wt'], { headers: authHeaders({ host: 'evil.example' }) }), 403)
  const negotiated = await new Promise((resolve) => {
    const ws = new WebSocket(url, ['dsh-wt', `dsh-wt.${bootToken()}`])
    ws.on('open', () => { const p = ws.protocol; ws.terminate(); resolve(p) })
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(`HTTP ${res.statusCode}`) })
    ws.on('error', () => {})
  })
  assert.equal(negotiated, 'dsh-wt', 'the server answers with the plain protocol and never echoes the token')
})
