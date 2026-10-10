// Regression: terminals must keep working when an optional piece of apply() cannot be set up.
// A real cordis context THROWS on a property that was not injected (`ctx.wtSpawn` once did, which left
// the upgrade route registered with no connection listener: every terminal sat on "connecting").

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-wt-resilience-'))
process.env.DSH_HOME = home
const stops = []
after(() => {
  for (const stop of stops) stop()
  rmSync(home, { recursive: true, force: true })
})

function fakeHandle() {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  return { output: new EventEmitter(), done, pid: 4242, write() {}, resize() {}, signalForeground() {}, terminate() { finish({ exitCode: null }) } }
}

/** A context shaped like cordis': reading anything that was not provided throws. */
function strictCtx(base) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

async function attach(ctxParts) {
  const upgrades = []
  const teardowns = []
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    apply(strictCtx({
      webServer: { registerUpgrade: (r) => { upgrades.push(r); return () => {} }, ...ctxParts.webServer },
      subprocess: { spawnTerminal: async () => fakeHandle() },
      effect: (fn) => { teardowns.push(fn()); return () => {} },
    }))
  } finally {
    console.warn = warn
  }
  const http = createServer()
  http.on('upgrade', (req, socket, head) => upgrades[0].handler(req, socket, head))
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  stops.push(() => { for (const t of teardowns) t(); http.close() })
  const ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/terminal/ws?id=r${Date.now()}&shell=cmd&cols=80&rows=24`)
  const frame = await new Promise((resolve, reject) => {
    ws.on('message', (raw) => resolve(JSON.parse(String(raw))))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('no frame: terminal stuck on connecting')), 3000)
  })
  ws.close()
  return { frame, warnings }
}

test('a normal apply() with a strict ctx logs no warnings and serves terminals', async () => {
  const { frame, warnings } = await attach({ webServer: { register: () => () => {} } })
  assert.equal(frame.type, 'attached')
  assert.deepEqual(warnings, [])
})

test('every optional route failing to register still serves terminals', async () => {
  const { frame, warnings } = await attach({
    webServer: {
      register: (route) => {
        throw new Error(`duplicate exact route "${route.path}"`)
      },
    },
  })
  assert.equal(frame.type, 'attached')
  assert.ok(warnings.some((w) => w.includes('[web-terminal]') && w.includes('/api/dsh-web-terminal/paths')), warnings.join('\n'))
})
