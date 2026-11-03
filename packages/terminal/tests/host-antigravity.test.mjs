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
import { registry } from '../lib/providers/index.js'

const testHome = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-home-antigravity')
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

async function open(query = '') {
  const id = `ag${Date.now()}x${++seq}`
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?id=${id}${query}`)
  const frames = []
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  await until(() => frames.some((f) => f.type === 'attached'))
  return { ws, frames, handle: spawned.at(-1).handle, spec: spawned.at(-1).spec }
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
