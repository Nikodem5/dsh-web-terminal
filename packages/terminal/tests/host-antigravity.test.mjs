// Antigravity end to end on the host: a terminal the client says is an Antigravity one gets `agent` frames
// from the OSC 7501 sequences in its output; any other terminal gets none, even when the bytes are printed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { authed, localReq } from './helpers/local-auth.mjs'
import { registry } from '../lib/providers/index.js'

const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home-antigravity')
process.env.DSH_HOME = testHome
process.env.DSH_WT_AUTH_HOLD_MS = '600'
// The integration reads agy's config from here and "installs" with a fake agy: the real ~/.gemini is never touched.
const testGemini = join(testHome, 'gemini')
process.env.DSH_WT_GEMINI_DIR = testGemini
process.env.DSH_WT_AGY_COMMAND = JSON.stringify([process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-agy.mjs')])
const HOLD = 600

const strictCtx = (base) => new Proxy(base, {
  get(target, prop) {
    if (prop in target) return target[prop]
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})

function fakeHandle() {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output, done, pid: 4245, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) } }
}

const thrower = { id: 'fake-throws', label: 'Fake', commands: ['dsh-wt-no-such-command-t'], observe: () => ({ feed: () => { throw new Error('boom') } }) }
const off = registry.register(thrower)

const routes = { upgrade: [], http: [] }
const spawned = []
let teardown
let server
let port

before(async () => {
  rmSync(testHome, { recursive: true, force: true })
  apply(strictCtx({
    webServer: { register: (route) => { routes.http.push(route); return () => {} }, registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} } },
    subprocess: { spawnTerminal: async (spec) => { const handle = fakeHandle(); spawned.push({ spec, handle }); return handle } },
    on: () => () => {},
    effect: (fn) => { teardown = fn(); return () => {} },
  }))
  const upgrade = routes.upgrade.find((r) => r.path === '/terminal/ws')
  server = createServer()
  server.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(() => {
  if (typeof teardown === 'function') teardown()
  off()
  server.close()
  rmSync(testHome, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const until = async (predicate, ms = 20000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

async function open(query = '', id = `ag${Date.now()}x${++seq}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?id=${id}${query}`, authed())
  const frames = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await until(() => frames.some((f) => f.type === 'attached'))
  return { ws, frames, id, handle: spawned.at(-1).handle, spec: spawned.at(-1).spec }
}

const working = '\x1b]7501;state=working:app=antigravity\x07'
const agents = (frames) => frames.filter((f) => f.type === 'agent')

test('a terminal started as antigravity gets agent frames, split sequences included', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from(working.slice(0, 9)))
  t.handle.output.emit('data', Buffer.from(working.slice(9)))
  assert.ok(await until(() => agents(t.frames).length === 1))
  assert.equal(agents(t.frames)[0].provider, 'antigravity')
  assert.equal(agents(t.frames)[0].state, 'working')
  // the bytes still reach the screen unchanged
  assert.ok(await until(() => t.frames.some((f) => f.type === 'data')))
  assert.equal(t.frames.filter((f) => f.type === 'data').map((f) => f.data).join(''), working)
  t.ws.close()
})

test('the exit hint arrives as an ended signal carrying the conversation id', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from('Resume with -c (or command below):\r\nagy --conversation=d68c6b12-644d-4dea-93aa-b1ead1117390\r\n'))
  assert.ok(await until(() => agents(t.frames).length === 1))
  assert.equal(agents(t.frames)[0].state, 'ended')
  assert.equal(agents(t.frames)[0].session, 'd68c6b12-644d-4dea-93aa-b1ead1117390')
  t.ws.close()
})

test('the shell gets AGY_CLI_OSC7501', async () => {
  const t = await open()
  assert.equal(t.spec.env.AGY_CLI_OSC7501, 'on')
  t.ws.close()
})

test('a terminal opened the moment the plugin starts still gets the provider variables', async () => {
  // A second instance, opened before its signal server has even started listening: the spawn waits for the providers.
  const own = { upgrade: [] }
  const ownSpawned = []
  let ownTeardown
  apply(strictCtx({
    webServer: { register: () => () => {}, registerUpgrade: (route) => { own.upgrade.push(route); return () => {} } },
    subprocess: { spawnTerminal: async (spec) => { const handle = fakeHandle(); ownSpawned.push({ spec, handle }); return handle } },
    on: () => () => {},
    effect: (fn) => { ownTeardown = fn(); return () => {} },
  }))
  const http = createServer()
  http.on('upgrade', (req, socket, head) => own.upgrade[0].handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/terminal/ws?id=early1`, authed())
    const attached = new Promise((resolve) => ws.on('message', (raw) => JSON.parse(String(raw)).type === 'attached' && resolve()))
    await attached
    assert.equal(ownSpawned.length, 1)
    assert.equal(ownSpawned[0].spec.env.AGY_CLI_OSC7501, 'on')
    ws.close()
  } finally {
    ownTeardown()
    http.close()
  }
})

test('when the shell exits, the agent it ran is marked ended and keeps its provider', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from(working))
  assert.ok(await until(() => agents(t.frames).length === 1))
  t.handle.terminate()
  assert.ok(await until(() => t.frames.some((f) => f.type === 'exit')))
  const last = agents(t.frames).at(-1)
  assert.equal(last.state, 'ended')
  assert.equal(last.provider, 'antigravity')
  // the ended frame comes before the exit frame
  assert.ok(t.frames.indexOf(last) < t.frames.findIndex((f) => f.type === 'exit'))
  t.ws.close()
  const again = await open('&provider=antigravity', t.id)
  assert.equal(again.frames.find((f) => f.type === 'attached').agent.state, 'ended')
  again.ws.close()
})

test('an exit hint with no newline after it is read when the shell exits', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from('Resume with -c (or command below):\r\nagy --conversation=d68c6b12-644d-4dea-93aa-b1ead1117390'))
  await until(() => t.frames.some((f) => f.type === 'data'))
  assert.equal(agents(t.frames).length, 0)
  t.handle.terminate()
  assert.ok(await until(() => t.frames.some((f) => f.type === 'exit')))
  const ended = agents(t.frames)
  assert.equal(ended.length, 1)
  assert.equal(ended[0].session, 'd68c6b12-644d-4dea-93aa-b1ead1117390')
  t.ws.close()
})

test('a shell that never had an agent sends no agent frame on exit', async () => {
  const t = await open()
  t.handle.terminate()
  assert.ok(await until(() => t.frames.some((f) => f.type === 'exit')))
  assert.equal(agents(t.frames).length, 0)
  t.ws.close()
})

test('a terminal without a provider, with an unknown one, or without an observer gets no frames', async () => {
  for (const query of ['', '&provider=nope', '&provider=claude']) {
    const t = await open(query)
    t.handle.output.emit('data', Buffer.from(working))
    assert.ok(await until(() => t.frames.some((f) => f.type === 'data')))
    assert.equal(agents(t.frames).length, 0, query)
    t.ws.close()
  }
})

test('an observer that throws is contained: output still flows', async () => {
  const t = await open('&provider=fake-throws')
  t.handle.output.emit('data', Buffer.from('one'))
  t.handle.output.emit('data', Buffer.from('two'))
  assert.ok(await until(() => t.frames.filter((f) => f.type === 'data').map((f) => f.data).join('') === 'onetwo'))
  assert.equal(agents(t.frames).length, 0)
  t.ws.close()
})

// agy shows kind=auth for a moment at every start: the host holds it back for DSH_WT_AUTH_HOLD_MS.
const auth = '\x1b]7501;state=blocked:kind=auth:app=antigravity\x07'
const permission = '\x1b]7501;state=blocked:kind=permission:app=antigravity\x07'

test('auth followed by working within the hold gives only working', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from(auth))
  await sleep(100)
  assert.equal(agents(t.frames).length, 0)
  t.handle.output.emit('data', Buffer.from(working))
  assert.ok(await until(() => agents(t.frames).length === 1))
  await sleep(HOLD + 300)
  assert.deepEqual(agents(t.frames).map((f) => f.state), ['working'])
  t.ws.close()
})

test('auth and working in one chunk gives only working', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from(auth + working))
  assert.ok(await until(() => agents(t.frames).length === 1))
  await sleep(HOLD + 300)
  assert.deepEqual(agents(t.frames).map((f) => f.state), ['working'])
  t.ws.close()
})

test('auth alone gives needs-you after the hold, stamped when it is sent', async () => {
  const t = await open('&provider=antigravity')
  const start = Date.now()
  t.handle.output.emit('data', Buffer.from(auth))
  await sleep(HOLD / 2)
  assert.equal(agents(t.frames).length, 0)
  assert.ok(await until(() => agents(t.frames).length === 1))
  const frame = agents(t.frames)[0]
  assert.equal(frame.state, 'needs-you')
  assert.equal(frame.kind, 'auth')
  assert.equal(frame.provider, 'antigravity')
  assert.ok(frame.at - start >= HOLD - 50, `sent after ${frame.at - start} ms`)
  t.ws.close()
})

test('a second auth signal does not extend the hold or send twice', async () => {
  const t = await open('&provider=antigravity')
  const start = Date.now()
  t.handle.output.emit('data', Buffer.from(auth))
  await sleep(HOLD * 2 / 3)
  t.handle.output.emit('data', Buffer.from(auth))
  assert.ok(await until(() => agents(t.frames).length === 1))
  assert.ok(Date.now() - start < HOLD * 1.5, `arrived after ${Date.now() - start} ms`)
  await sleep(HOLD + 200)
  assert.equal(agents(t.frames).length, 1)
  t.ws.close()
})

test('a permission prompt is not delayed', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from(permission))
  assert.ok(await until(() => agents(t.frames).length === 1, HOLD / 2))
  assert.equal(agents(t.frames)[0].state, 'needs-you')
  assert.equal(agents(t.frames)[0].kind, undefined)
  t.ws.close()
})

test('a browser attaching during the hold sees no agent, and the held signal reaches it once applied', async () => {
  const first = await open('&provider=antigravity')
  first.handle.output.emit('data', Buffer.from(auth))
  first.ws.close()
  const second = await open('&provider=antigravity', first.id)
  assert.equal(second.frames.find((f) => f.type === 'attached').agent, null)
  assert.ok(await until(() => agents(second.frames).length === 1))
  second.ws.close()
  const third = await open('&provider=antigravity', first.id)
  assert.equal(third.frames.find((f) => f.type === 'attached').agent.state, 'needs-you')
  third.ws.close()
})

test('the session exiting during the hold sends nothing', async () => {
  const t = await open('&provider=antigravity')
  t.handle.output.emit('data', Buffer.from(auth))
  t.handle.terminate()
  assert.ok(await until(() => t.frames.some((f) => f.type === 'exit')))
  await sleep(HOLD + 300)
  assert.equal(agents(t.frames).length, 0)
  t.ws.close()
})

test('the hold firing with no browser attached does not throw, and the next browser gets the state', async () => {
  const first = await open('&provider=antigravity')
  first.handle.output.emit('data', Buffer.from(auth))
  first.ws.close()
  await sleep(HOLD + 300)
  const second = await open('&provider=antigravity', first.id)
  assert.equal(second.frames.find((f) => f.type === 'attached').agent.kind, 'auth')
  second.ws.close()
})

// ── the opt-in integration ──

/** Call an HTTP route of this host as a local client. */
const callRoute = (path, method = 'GET', body) =>
  new Promise((resolve) => {
    const req = new EventEmitter()
    Object.assign(req, localReq({ method }))
    const res = { writeHead(status) { this.status = status }, end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }) } }
    routes.http.find((r) => r.path === path).handler(req, res)
    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  })

/** POST to the host's signal server as the agy hook / status line would. */
function postSignal(spec, route, token, body) {
  const target = new URL(`${spec.env.DSH_WT_AGY_SIGNAL}/${route}`)
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'x-dsh-wt-token': token } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const CONV = 'b5122a04-b51c-4cce-bcf6-f8369dd0f084'

test('every terminal gets the signal URL; without the opt-in agy starts as typed', async () => {
  const t = await open()
  assert.match(t.spec.env.DSH_WT_AGY_SIGNAL, /^http:\/\/127\.0\.0\.1:\d+\/signal$/)
  t.ws.close()
  const info = await callRoute('/api/dsh-web-terminal/info')
  assert.deepEqual(info.body.providers.antigravity.launch, {})
  const state = await callRoute('/api/dsh-web-terminal/integration')
  assert.equal(state.body.integrations.antigravity.enabled, false)
})

test('install and remove from the integration route (a fake agy, a temp agy config folder)', async () => {
  const bad = await callRoute('/api/dsh-web-terminal/integration', 'POST', { provider: 'antigravity', action: 'nope' })
  assert.equal(bad.status, 400)
  const installed = await callRoute('/api/dsh-web-terminal/integration', 'POST', { provider: 'antigravity', action: 'install' })
  assert.equal(installed.body.ok, true, JSON.stringify(installed.body))
  assert.equal(installed.body.status.pluginInstalled, true)
  assert.ok(existsSync(join(testGemini, 'config', 'plugins', 'dsh-web-terminal', 'plugin.json')))
  const info = await callRoute('/api/dsh-web-terminal/info')
  const settingsPath = info.body.providers.antigravity.launch.settingsPath
  assert.match(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command, /agy-statusline\.mjs$/)
  const removed = await callRoute('/api/dsh-web-terminal/integration', 'POST', { provider: 'antigravity', action: 'remove' })
  assert.equal(removed.body.status.enabled, false)
  assert.equal(existsSync(join(testGemini, 'config', 'plugins', 'dsh-web-terminal')), false)
  assert.deepEqual((await callRoute('/api/dsh-web-terminal/info')).body.providers.antigravity.launch, {})
})

test('trusted hook and status-line signals set the state, edits and usage; printed sequences no longer can', async () => {
  const t = await open('&provider=antigravity')
  const token = t.spec.env.DSH_WT_TOKEN
  assert.equal(await postSignal(t.spec, 'antigravity-hook', 'wrong', { event: 'PreInvocation', payload: {} }), 401)
  assert.equal(await postSignal(t.spec, 'antigravity-status', token, { agent_state: 'idle', conversation_id: CONV, quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_time: new Date(Date.now() + 3600_000).toISOString() } }, cost: { total_usd: 0.5 } }), 204)
  assert.ok(await until(() => agents(t.frames).length === 1))
  assert.deepEqual([agents(t.frames)[0].state, agents(t.frames)[0].session], ['idle', CONV])

  // A program printing a forged sequence: ignored from now on.
  t.handle.output.emit('data', Buffer.from('\x1b]7501;state=blocked:kind=permission:app=antigravity\x07'))
  await until(() => t.frames.some((f) => f.type === 'data'))
  assert.equal(await postSignal(t.spec, 'antigravity-hook', token, { event: 'PostToolUse', payload: { conversationId: CONV, error: '', toolCall: { name: 'write_file', args: { Path: '/w/hello.txt' } } } }), 204)
  assert.ok(await until(() => t.frames.some((f) => f.type === 'edits')))
  assert.deepEqual(t.frames.find((f) => f.type === 'edits').files.map((e) => [e.path, e.tool]), [['/w/hello.txt', 'write_file']])
  assert.equal(await postSignal(t.spec, 'antigravity-hook', token, { event: 'Stop', payload: { conversationId: CONV, error: '', terminationReason: 'NO_TOOL_CALL' } }), 204)
  assert.ok(await until(() => agents(t.frames).at(-1).state === 'finished'))
  assert.deepEqual(agents(t.frames).map((f) => f.state), ['idle', 'working', 'finished'], 'the forged needs-you never arrived')

  const stats = await callRoute('/api/dsh-web-terminal/stats')
  assert.equal(stats.body.providers.antigravity.limits.fiveHour.usedPct, 25)
  assert.equal(stats.body.providers.antigravity.cost.totalUsd, 0.5)
  assert.equal(stats.body.limits.fiveHour, null, 'Claude\'s top-level numbers are untouched')
  t.ws.close()
})
