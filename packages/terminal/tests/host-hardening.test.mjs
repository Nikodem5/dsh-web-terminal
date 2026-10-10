// Hardening tests for the host half: origin policy, heartbeat, backpressure,
// replay boundaries and orphan reaping. Same fake-PTY approach as
// host-protocol.test.mjs, but each group applies its own plugin instance so the
// environment-driven timings can be shortened.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'
import { originAllowed, parseExtraOrigins } from '../lib/origin.js'

// Own home: node --test runs files in parallel processes and host-protocol removes its own.
const home = mkdtempSync(join(tmpdir(), 'dsh-wt-hardening-'))
process.env.DSH_HOME = home

function fakeHandle() {
  const output = new EventEmitter()
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return {
    output,
    done,
    pid: 4242,
    terminated: false,
    write() {},
    resize() {},
    signalForeground() {},
    terminate() { this.terminated = true; finish({ exitCode: null }) },
    emit(text) { output.emit('data', Buffer.from(text)) },
    exit(exitCode) { finish({ exitCode }) },
  }
}

const hosts = []

/** Apply a fresh plugin instance with the given env overrides (read at apply time) and serve it. */
async function startHost(env = {}) {
  const saved = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
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
        const handle = fakeHandle()
        spawned.push({ spec, handle })
        return handle
      },
    },
    effect: (fn) => { teardown = fn(); return () => {} },
  })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const upgrade = routes.upgrade.find((r) => r.path === '/terminal/ws')
  const http = createServer()
  http.on('upgrade', (req, socket, head) => upgrade.handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  const host = {
    spawned,
    port,
    stop() { teardown(); http.close() },
    info: () =>
      new Promise((resolve) => {
        routes.http.find((r) => r.path === '/api/dsh-web-terminal/info').handler({ method: 'GET' }, { writeHead() {}, end: (p) => resolve(JSON.parse(p)) })
      }),
    /** Open a socket; resolves on open with collected frames. `options` go to the ws client. */
    connect(query, options) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws?${query}`, options)
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
const freshId = () => `h${Date.now()}x${++seq}`
const until = async (predicate, ms = 20000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await sleep(10)
  }
  return false
}

// ── origin ──

test('originAllowed: absent, same-origin loopback, dsh-app and configured origins pass', () => {
  const extra = parseExtraOrigins(' https://Mine.example/ , http://other.test:8080 ')
  assert.deepEqual(extra, ['https://mine.example', 'http://other.test:8080'])
  for (const origin of [
    undefined,
    'http://127.0.0.1:3000', // the harness itself
    'http://localhost:3000', // loopback names are interchangeable
    'http://[::1]:3000',
    'HTTP://LOCALHOST:3000',
    'https://127.0.0.1:3000', // the scheme is not compared, the host and port are
    'dsh-app://app',
    'dsh-app://anything/path',
    'https://mine.example',
    'http://other.test:8080',
  ]) {
    assert.equal(originAllowed(origin, '127.0.0.1:3000', extra), true, String(origin))
  }
  // Default ports count as the port they are.
  assert.equal(originAllowed('http://localhost', '127.0.0.1', []), true)
  assert.equal(originAllowed('https://localhost', '127.0.0.1:443', []), true)
})

test('originAllowed: foreign, malformed and other-port origins are refused', () => {
  for (const origin of [
    'https://evil.example',
    'http://127.0.0.1.evil.example:3000',
    'http://localhost.evil.example:3000',
    'http://127.0.0.1:9999', // another local web app, not the harness
    'http://localhost:5173',
    'null',
    '',
    'not a url',
    'file:///etc/passwd',
    'chrome-extension://abc',
    'javascript:alert(1)',
  ]) {
    assert.equal(originAllowed(origin, '127.0.0.1:3000', []), false, JSON.stringify(origin))
  }
})

test('originAllowed: DNS rebinding (Origin equals Host, but not loopback) is refused', () => {
  assert.equal(originAllowed('http://attacker.example:3000', 'attacker.example:3000', []), false)
  assert.equal(originAllowed('http://harness.lan:3000', 'harness.lan:3000', []), false)
  // ...unless the owner lists it.
  const extra = parseExtraOrigins('http://harness.lan:3000')
  assert.equal(originAllowed('http://harness.lan:3000', 'harness.lan:3000', extra), true)
  // A loopback Origin with a rebinding Host is refused too.
  assert.equal(originAllowed('http://127.0.0.1:3000', 'attacker.example:3000', []), false)
  assert.equal(originAllowed('http://127.0.0.1:3000', undefined, []), false)
  assert.equal(originAllowed('http://127.0.0.1:3000', '', []), false)
})

test('upgrade: a foreign Origin gets 403 and no shell is spawned', async () => {
  const host = await startHost()
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/terminal/ws?id=${freshId()}`, { origin: 'https://evil.example' })
  const status = await new Promise((resolve) => {
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode) })
    ws.on('error', () => {})
  })
  assert.equal(status, 403)
  await sleep(50)
  assert.equal(host.spawned.length, 0)
})

test('upgrade: malformed Origin values are refused', async () => {
  const host = await startHost()
  for (const origin of ['null', 'not a url']) {
    const ws = new WebSocket(`ws://127.0.0.1:${host.port}/terminal/ws?id=${freshId()}`, { origin })
    const status = await new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode) })
      ws.on('error', () => {})
    })
    assert.equal(status, 403, origin)
  }
  assert.equal(host.spawned.length, 0)
})

test('upgrade: every allowed Origin form is accepted', async () => {
  const host = await startHost({ DSH_WT_ALLOWED_ORIGINS: 'https://extra.example' })
  const origins = [
    undefined,
    `http://127.0.0.1:${host.port}`, // same origin as the Host header
    `http://localhost:${host.port}`,
    `http://[::1]:${host.port}`,
    'dsh-app://app',
    'https://extra.example',
  ]
  for (const origin of origins) {
    const { ws, frames } = await host.connect(`id=${freshId()}`, origin === undefined ? undefined : { origin })
    assert.ok(await until(() => frames.some((f) => f.type === 'attached')), String(origin))
    ws.close()
  }
  assert.equal(host.spawned.length, origins.length)
})

// ── heartbeat ──

test('heartbeat: a socket that stops answering pings is terminated, the shell survives', async () => {
  const host = await startHost({ DSH_WT_HEARTBEAT_MS: '40' })
  const id = freshId()
  const mute = await host.connect(`id=${id}`, { autoPong: false })
  assert.ok(await until(() => mute.frames.length > 0))
  const code = await Promise.race([mute.closed, sleep(5000).then(() => 'timeout')])
  assert.equal(code, 1006)
  assert.equal(host.spawned[0].handle.terminated, false)
  // The session is detached and can be reattached.
  const again = await host.connect(`id=${id}`)
  assert.ok(await until(() => again.frames.length > 0))
  assert.equal(again.frames[0].created, false)
  again.ws.close()
})

test('heartbeat: a responsive socket stays open across many intervals', async () => {
  // Server and client share this event loop, so a stall longer than one interval makes the server's next
  // tick run before the client has read the pong. Keep the interval large next to any plausible stall
  // (parallel test files), and span several ticks so a heartbeat that terminated would be seen.
  const host = await startHost({ DSH_WT_HEARTBEAT_MS: '300' })
  const { ws, frames } = await host.connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  let pings = 0
  ws.on('ping', () => { pings++ })
  await sleep(1300)
  assert.ok(pings >= 2, `pings seen: ${pings}`)
  assert.equal(ws.readyState, WebSocket.OPEN)
  ws.close()
})

// ── backpressure ──

test('backpressure: a congested socket stops receiving data frames and gets one resync after draining', async () => {
  const host = await startHost({ DSH_WT_HIGH_WATER: String(64 * 1024), DSH_WT_LOW_WATER: String(16 * 1024), DSH_WT_DRAIN_MS: '20' })
  const { ws, frames } = await host.connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  const { handle } = host.spawned[0]
  ws._socket.pause() // a browser that stopped reading
  const chunk = 'z'.repeat(1024 * 1024)
  const chunks = 48
  for (let i = 0; i < chunks; i++) {
    handle.emit(chunk)
    await sleep(2)
  }
  handle.emit('LAST')
  ws._socket.resume()
  assert.ok(await until(() => frames.some((f) => f.type === 'resync')), 'resync arrives after the socket drains')
  await sleep(150)
  assert.equal(frames.filter((f) => f.type === 'resync').length, 1)
  const resync = frames.find((f) => f.type === 'resync')
  assert.equal(resync.replay.length, 400_000)
  assert.ok(resync.replay.endsWith('zzzLAST'))
  assert.ok(frames.filter((f) => f.type === 'data').length < chunks, 'some frames were dropped instead of queued')
  // Forwarding resumes after the resync.
  handle.emit('after')
  assert.ok(await until(() => frames.some((f) => f.type === 'data' && f.data === 'after')))
  ws.close()
})

test('backpressure: a normal socket never sees a resync', async () => {
  const host = await startHost()
  const { ws, frames } = await host.connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  host.spawned[0].handle.emit('hello')
  await until(() => frames.some((f) => f.type === 'data'))
  await sleep(100)
  assert.ok(!frames.some((f) => f.type === 'resync'))
  ws.close()
})

// ── replay boundaries ──

test('replay: a truncated buffer does not start inside an escape sequence', async () => {
  const host = await startHost()
  const first = await host.connect(`id=${freshId()}`)
  await until(() => first.frames.length > 0)
  const { handle } = host.spawned[0]
  // The buffer ends 400,000 chars after a point 5 chars into this CSI, so a blind slice would
  // keep "8;2;255;100;50m..." (a dangling CSI body).
  const csi = '[38;2;255;100;50m'
  handle.emit('a'.repeat(1000) + csi + 'b'.repeat(399_985 - 10))
  handle.emit('c'.repeat(10))
  await until(() => first.frames.filter((f) => f.type === 'data').length === 2)
  first.ws.close()
  await first.closed
  const id = (await host.info()).sessions[0].id
  const second = await host.connect(`id=${id}`)
  await until(() => second.frames.length > 0)
  const { replay } = second.frames[0]
  assert.ok(replay.startsWith('b'), 'starts after the whole CSI, not inside it')
  assert.ok(replay.length <= 400_000)
  assert.ok(replay.endsWith('c'.repeat(10)))
  second.ws.close()
})

// ── orphan reaping ──

test('orphans: a detached idle session is destroyed, an attached one never is', async () => {
  const host = await startHost({ DSH_WT_ORPHAN_MS: '150', DSH_WT_EXITED_MS: '100000', DSH_WT_SWEEP_MS: '20' })
  const attached = await host.connect(`id=${freshId()}`)
  const detached = await host.connect(`id=${freshId()}`)
  await until(() => attached.frames.length > 0 && detached.frames.length > 0)
  detached.ws.close()
  await detached.closed
  const [keep, gone] = host.spawned.map((s) => s.handle)
  assert.ok(await until(() => gone.terminated), 'idle detached session reaped')
  assert.equal(keep.terminated, false)
  await sleep(300)
  assert.equal(keep.terminated, false, 'attached session survives past the orphan limit')
  assert.equal((await host.info()).sessions.length, 1)
  attached.ws.close()
})

test('orphans: output keeps a detached session alive', async () => {
  const host = await startHost({ DSH_WT_ORPHAN_MS: '200', DSH_WT_EXITED_MS: '100000', DSH_WT_SWEEP_MS: '20' })
  const { ws, frames, closed } = await host.connect(`id=${freshId()}`)
  await until(() => frames.length > 0)
  ws.close()
  await closed
  const { handle } = host.spawned[0]
  for (let i = 0; i < 12; i++) {
    handle.emit('tick')
    await sleep(50)
  }
  assert.equal(handle.terminated, false, '600 ms of activity outlives a 200 ms limit')
  assert.ok(await until(() => handle.terminated), 'and is reaped once quiet')
})

test('orphans: an exited detached session is reaped quickly, an exited attached one is kept', async () => {
  const host = await startHost({ DSH_WT_ORPHAN_MS: '100000', DSH_WT_EXITED_MS: '100', DSH_WT_SWEEP_MS: '20' })
  const stay = await host.connect(`id=${freshId()}`)
  const leave = await host.connect(`id=${freshId()}`)
  await until(() => stay.frames.length > 0 && leave.frames.length > 0)
  host.spawned[0].handle.exit(0)
  host.spawned[1].handle.exit(0)
  await until(() => stay.frames.some((f) => f.type === 'exit') && leave.frames.some((f) => f.type === 'exit'))
  leave.ws.close()
  await leave.closed
  assert.ok(await until(() => host.spawned[1].handle.terminated), 'detached exited session reaped')
  await sleep(250)
  assert.equal(host.spawned[0].handle.terminated, false)
  assert.equal((await host.info()).sessions.length, 1)
  stay.ws.close()
})
