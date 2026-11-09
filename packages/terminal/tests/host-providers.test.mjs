// The host's provider registry end to end: what `/info` lists, what a provider's `prepare` adds to a
// shell, and how `/signal/<id>` reaches a registered adapter. Fake providers stand in for ones that do not
// exist yet (env-var injection, zero-config). A fake PTY and a strict ctx, like the other host tests.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { authed, localReq } from './helpers/local-auth.mjs'
import { registry } from '../lib/providers/index.js'

const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home-providers')
process.env.DSH_HOME = testHome

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
  return { output, done, pid: 4244, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) }, exit(exitCode) { finish({ exitCode }) } }
}

/** What the fake providers were asked to do. */
const calls = { intercepted: [], routed: [], prepared: [] }

/** Injects through environment variables, owns an extra route and consumes one event itself. */
const envProvider = {
  id: 'fake-env',
  label: 'Fake (env)',
  commands: ['dsh-wt-no-such-command-a', 'dsh-wt-no-such-command-b'],
  adapter: (body) => (body.event === 'ask' ? { state: 'needs-you', detail: 'approve?' } : body.event === 'go' ? { state: 'working', detail: '' } : undefined),
  prepare: (env) => {
    calls.prepared.push(env)
    return { launch: { via: 'env' }, env: { FAKE_AGENT_CONFIG: join(env.dir, 'fake-agent.json') } }
  },
  intercept: ({ body }) => {
    calls.intercepted.push(body)
    return body.event === 'consumed'
  },
  routes: { 'fake-extra': ({ id, body }) => calls.routed.push({ id, body }) },
}
/** No injection and no adapter: only neutral signals. */
const zeroProvider = { id: 'fake-zero', label: 'Fake (zero-config)', commands: ['dsh-wt-no-such-command-c'] }
/** Cannot write its files: must not take the others down. */
const brokenProvider = { id: 'fake-broken', label: 'Fake (broken)', commands: ['dsh-wt-no-such-command-d'], prepare: () => { throw new Error('disk full') } }

const unregister = [envProvider, zeroProvider, brokenProvider].map((p) => registry.register(p))

const routes = { http: [], upgrade: [] }
const spawned = []
let teardown
let server
let port

before(async () => {
  rmSync(testHome, { recursive: true, force: true })
  apply(strictCtx({
    webServer: {
      register: (route) => { routes.http.push(route); return () => {} },
      registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} },
    },
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
  for (const off of unregister) off()
  server.close()
  rmSync(testHome, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const freshId = () => `p${Date.now()}x${++seq}`
const until = async (predicate, ms = 20000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

function connect(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?${query}`, authed())
    const frames = []
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
    ws.on('open', () => resolve({ ws, frames }))
    ws.on('error', reject)
  })
}

const info = () => {
  const route = routes.http.find((r) => r.path === '/api/dsh-web-terminal/info')
  return new Promise((resolve) => route.handler(localReq(), { writeHead() {}, end: (p) => resolve(JSON.parse(p)) }))
}

async function post(path, token, body) {
  const { providers } = await info()
  const settings = JSON.parse(readFileSync(providers.claude.launch.settingsPath, 'utf8'))
  const target = new URL(settings.hooks.Stop[0].hooks[0].url)
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, path, method: 'POST', headers: { 'x-dsh-wt-token': token } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

async function session() {
  const c = await connect(`id=${freshId()}`)
  await until(() => c.frames.some((f) => f.type === 'attached'))
  return { ...c, token: spawned.at(-1).spec.env.DSH_WT_TOKEN }
}

test('/info lists every provider with its PATH state and launch hint', async () => {
  const { providers } = await info()
  assert.deepEqual(Object.keys(providers), ['claude', 'antigravity', 'fake-env', 'fake-zero', 'fake-broken'])
  assert.equal(typeof providers.claude.available, 'boolean')
  assert.match(providers.claude.launch.settingsPath, /claude-settings-\d+\.json$/)
  assert.deepEqual(providers['fake-env'], { available: false, path: null, launch: { via: 'env' } })
  assert.deepEqual(providers['fake-zero'], { available: false, path: null, launch: {} }, 'no prepare step: ready as typed')
  assert.equal(providers['fake-broken'].launch, null, 'prepare threw: not ready')
})

test('prepare gets where to write and where hooks post, once', async () => {
  const [env] = calls.prepared
  assert.equal(calls.prepared.length, 1)
  assert.equal(env.dir, join(testHome, 'web-terminal'))
  assert.equal(env.pid, process.pid)
  assert.match(env.base, /^http:\/\/127\.0\.0\.1:\d+\/signal$/)
  assert.equal(typeof env.pidAlive, 'function')
})

test('a provider that cannot prepare does not stop the others', async () => {
  const { providers } = await info()
  assert.ok(providers.claude.launch.settingsPath, 'Claude still has its settings file')
  assert.deepEqual(providers['fake-env'].launch, { via: 'env' })
})

test('a provider that injects through the environment reaches every shell, beside the secret', async () => {
  const { ws } = await session()
  const env = spawned.at(-1).spec.env
  assert.equal(env.FAKE_AGENT_CONFIG, join(testHome, 'web-terminal', 'fake-agent.json'))
  assert.match(env.DSH_WT_TOKEN, /^[0-9a-f]{48}$/)
  ws.close()
})

test('/signal/<id> goes through the registered adapter', async () => {
  const { ws, frames, token } = await session()
  assert.equal(await post('/signal/fake-env', token, { event: 'ask' }), 204)
  await until(() => frames.some((f) => f.type === 'agent'))
  assert.deepEqual(frames.find((f) => f.type === 'agent'), { type: 'agent', provider: 'fake-env', state: 'needs-you', detail: 'approve?', at: frames.find((f) => f.type === 'agent').at })
  ws.close()
})

test('an event the adapter does not know says nothing, and an id with a safe session carries it', async () => {
  const { ws, frames, token } = await session()
  assert.equal(await post('/signal/fake-env', token, { event: 'nope' }), 204)
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  await post('/signal/fake-env', token, { event: 'go', session_id: 'abcdef12-3456' })
  await until(() => frames.some((f) => f.type === 'agent'))
  assert.equal(frames.find((f) => f.type === 'agent').session, 'abcdef12-3456')
  ws.close()
})

test('a provider can consume an event before it is read as a state', async () => {
  const { ws, frames, token } = await session()
  assert.equal(await post('/signal/fake-env', token, { event: 'consumed' }), 204)
  await sleep(50)
  assert.ok(calls.intercepted.some((b) => b.event === 'consumed'))
  assert.ok(!frames.some((f) => f.type === 'agent'), 'consumed: no state')
  ws.close()
})

test('a provider-owned route gets the body and the session, and is not an agent state', async () => {
  const { ws, frames, token } = await session()
  assert.equal(await post('/signal/fake-extra', token, { n: 1 }), 204)
  assert.equal(calls.routed.length, 1)
  assert.deepEqual(calls.routed[0].body, { n: 1 })
  assert.equal(typeof calls.routed[0].id, 'string')
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  ws.close()
})

test('a provider without an adapter accepts only neutral signals', async () => {
  const { ws, frames, token } = await session()
  await post('/signal/fake-zero', token, { event: 'ask' })
  await post('/signal/fake-zero', token, { state: 'bogus' })
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'), 'no adapter, no neutral state: rejected as before')
  await post('/signal/fake-zero', token, { state: 'finished', detail: 'done' })
  await until(() => frames.some((f) => f.type === 'agent'))
  assert.equal(frames.find((f) => f.type === 'agent').provider, 'fake-zero')
  ws.close()
})

test('an id nobody registered still needs a neutral state', async () => {
  const { ws, frames, token } = await session()
  assert.equal(await post('/signal/unheard-of', token, { hook_event_name: 'Stop' }), 204)
  await sleep(50)
  assert.ok(!frames.some((f) => f.type === 'agent'))
  ws.close()
})
