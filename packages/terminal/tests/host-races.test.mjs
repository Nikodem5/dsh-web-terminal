// Race and robustness tests for the host half: concurrent spawns, closes during a spawn,
// throwing providers, the signal allowlist and disposal before the signal server listens.
// Same fake-PTY approach as host-hardening.test.mjs, with a spawn that can be delayed or made to fail.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-races-'))
process.env.DSH_HOME = home

function fakeHandle(overrides = {}) {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return {
    output,
    done,
    pid: 4242,
    terminated: false,
    writes: [],
    signals: [],
    write(data) { this.writes.push(data) },
    resize() {},
    signalForeground(name) { this.signals.push(name) },
    terminate() { this.terminated = true; finish({ exitCode: null }) },
    ...overrides,
  }
}

const hosts = []

/** `spawn(spec, handle, n)` may delay or throw; the default resolves immediately. */
async function startHost({ spawn, handleOverrides } = {}) {
  const routes = { http: [], upgrade: [] }
  const spawned = []
  let teardown
  apply({
    webServer: {
      register: (route) => { routes.http.push(route); return () => {} },
      registerUpgrade: (route) => { routes.upgrade.push(route); return () => {} },
    },
    subprocess: {
      spawnTerminal: async (spec) => {
        const handle = fakeHandle(handleOverrides)
        spawned.push({ spec, handle })
        if (spawn !== undefined) await spawn(spec, handle, spawned.length)
        return handle
      },
    },
    effect: (fn) => { teardown = fn(); return () => {} },
  })
  const upgrade = routes.upgrade.find((r) => r.path === '/terminal/ws')
  const http = createServer()
  http.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  const host = {
    spawned,
    stop() { teardown(); http.close() },
    info: () =>
      new Promise((resolve) => {
        routes.http.find((r) => r.path === '/api/dsh-web-terminal/info').handler({ method: 'GET' }, { writeHead() {}, end: (p) => resolve(JSON.parse(p)) })
      }),
    /** Open a socket; resolves on open with the frames collected so far and later. */
    connect(query) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?${query}`)
        const frames = []
        const closed = new Promise((res) => ws.on('close', (code) => res(code)))
        ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
        ws.on('open', () => resolve({ ws, frames, closed }))
        ws.on('error', reject)
      })
    },
  }
  hosts.push(host)
  return host
}

after(() => {
  for (const host of hosts) host.stop()
  rmSync(home, { recursive: true, force: true })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const freshId = () => `r${Date.now()}x${++seq}`
const until = async (predicate, ms = 3000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await predicate()) return true
    await sleep(10)
  }
  return false
}

test('spawn race: two connections with one id during a slow spawn share one PTY', async () => {
  const host = await startHost({ spawn: () => sleep(150) })
  const id = freshId()
  const a = await host.connect(`id=${id}`)
  const b = await host.connect(`id=${id}`)
  assert.ok(await until(() => a.frames.length > 0 && b.frames.length > 0))
  assert.equal(host.spawned.length, 1, 'one PTY only')
  assert.equal(a.frames[0].created, true)
  assert.equal(b.frames[0].created, false, 'the second attaches as a reattach')
  assert.equal(await a.closed, 4000, 'first socket superseded')
  assert.equal((await host.info()).sessions.length, 1)
  b.ws.close()
})

test('spawn race: pending spawns count toward the session cap', async () => {
  const host = await startHost({ spawn: () => sleep(200) })
  const max = (await host.info()).maxSessions
  const conns = []
  for (let i = 0; i < max + 1; i++) conns.push(await host.connect(`id=${freshId()}`))
  assert.equal(await conns[max].closed, 1013)
  assert.ok(await until(() => conns.slice(0, max).every((c) => c.frames.length > 0)))
  assert.equal(host.spawned.length, max)
  for (const c of conns) c.ws.close()
})

test('spawn race: a failed spawn releases the id so a retry can spawn', async () => {
  let calls = 0
  const host = await startHost({ spawn: async () => { if (++calls === 1) throw new Error('boom') } })
  const id = freshId()
  const first = await host.connect(`id=${id}`)
  assert.equal(await first.closed, 1011)
  assert.ok(first.frames.some((f) => f.type === 'error'))
  const second = await host.connect(`id=${id}`)
  assert.ok(await until(() => second.frames.length > 0))
  assert.equal(second.frames[0].created, true)
  second.ws.close()
})

test('spawn race: a waiter on a failed spawn gets an error, not a hang', async () => {
  const host = await startHost({ spawn: async () => { await sleep(100); throw new Error('boom') } })
  const id = freshId()
  const a = await host.connect(`id=${id}`)
  const b = await host.connect(`id=${id}`)
  assert.equal(await a.closed, 1011)
  assert.equal(await b.closed, 1011)
  assert.equal((await host.info()).sessions.length, 0)
})

test('close during spawn: the session is stored detached and reaped by the sweep', async () => {
  process.env.DSH_WT_ORPHAN_MS = '100'
  process.env.DSH_WT_SWEEP_MS = '20'
  let host
  try {
    host = await startHost({ spawn: () => sleep(100) })
  } finally {
    delete process.env.DSH_WT_ORPHAN_MS
    delete process.env.DSH_WT_SWEEP_MS
  }
  const { ws, closed } = await host.connect(`id=${freshId()}`)
  ws.close()
  await closed
  assert.ok(await until(() => host.spawned.length === 1 && host.spawned[0].handle.terminated), 'orphan reaped')
  assert.equal((await host.info()).sessions.length, 0)
})

test('provider throwing synchronously from write, resize and signalForeground does not escape', async () => {
  const boom = () => { throw new Error('sync boom') }
  const host = await startHost({ handleOverrides: { write: boom, resize: boom, signalForeground: boom } })
  const { ws, frames } = await host.connect(`id=${freshId()}&cols=80&rows=24`)
  await until(() => frames.length > 0)
  const failures = []
  const onFail = (error) => failures.push(error)
  process.on('uncaughtException', onFail)
  try {
    ws.send(JSON.stringify({ type: 'input', data: 'x' }))
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
    ws.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }))
    await sleep(100)
  } finally {
    process.off('uncaughtException', onFail)
  }
  assert.deepEqual(failures, [])
  assert.equal(ws.readyState, WebSocket.OPEN, 'connection still serving')
  ws.close()
})

test('provider throwing synchronously from terminate does not escape kill', async () => {
  const host = await startHost({ handleOverrides: { terminate() { throw new Error('sync boom') } } })
  const { ws, frames } = await host.connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  ws.send(JSON.stringify({ type: 'kill' }))
  assert.ok(await until(async () => (await host.info()).sessions.length === 0))
})

test('signal frame: only allowlisted names reach signalForeground', async () => {
  const host = await startHost()
  const { ws, frames } = await host.connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  for (const signal of ['SIGINT', 'SIGSTOP', 'rm -rf', 'SIGTERM', 42]) ws.send(JSON.stringify({ type: 'signal', signal }))
  const handle = host.spawned[0].handle
  assert.ok(await until(() => handle.signals.length === 2))
  await sleep(50)
  assert.deepEqual(handle.signals, ['SIGINT', 'SIGTERM'])
  ws.close()
})

test('dispose before the signal server listens: no settings file, info still resolves', async () => {
  const other = mkdtempSync(join(tmpdir(), 'dsh-wt-races-d-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = other
  try {
    const host = await startHost()
    const info = host.info()
    host.stop()
    host.stop = () => {}
    await Promise.race([info, sleep(2000).then(() => assert.fail('info hung'))])
    await sleep(100)
    const dir = join(other, 'web-terminal')
    assert.ok(!existsSync(dir) || readdirSync(dir).every((n) => !n.startsWith('claude-settings-')), 'no settings file written')
  } finally {
    process.env.DSH_HOME = previous
    rmSync(other, { recursive: true, force: true })
  }
})
