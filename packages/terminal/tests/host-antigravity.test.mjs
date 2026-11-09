// Antigravity end to end on the host: a terminal the client says is an Antigravity one gets `agent` frames
// from the OSC 7501 sequences in its output; any other terminal gets none, even when the bytes are printed.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { authed, localReq } from './helpers/local-auth.mjs'
import { registry } from '../lib/providers/index.js'

const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home-antigravity')
process.env.DSH_HOME = testHome
process.env.DSH_WT_AUTH_HOLD_MS = '600'
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

const routes = { upgrade: [] }
const spawned = []
let teardown
let server
let port

before(async () => {
  rmSync(testHome, { recursive: true, force: true })
  apply(strictCtx({
    webServer: { register: () => () => {}, registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} } },
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
  // The providers prepare once the signal server listens; terminals opened before that miss the variable.
  let on = false
  for (let i = 0; i < 400 && !on; i++) {
    const t = await open()
    on = t.spec.env.AGY_CLI_OSC7501 === 'on'
    t.ws.close()
    if (!on) await sleep(25)
  }
  assert.ok(on)
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
