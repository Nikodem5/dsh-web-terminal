// The shared test helper that keeps test servers off the ports fetch refuses to connect to.
//
//   node --test tests/listen-helper.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { BLOCKED_PORTS, listenLocal } from '../../shared/test/listen.mjs'

/** A server whose successive listen(0) calls land on the given ports. */
function scripted(ports) {
  const server = new EventEmitter()
  let current = 0
  server.listens = 0
  server.closes = 0
  server.listen = (_port, _host, cb) => {
    current = ports[server.listens++]
    queueMicrotask(cb)
  }
  server.address = () => ({ port: current })
  server.close = (cb) => {
    server.closes++
    queueMicrotask(cb)
  }
  return server
}

test('listenLocal asks again when the OS hands out a blocked port', async () => {
  const server = scripted([6000, 10080, 4045, 52000])
  assert.equal(await listenLocal(server), 52000)
  assert.equal(server.listens, 4)
  assert.equal(server.closes, 3, 'every blocked listener was closed')
})

test('listenLocal keeps a good first port', async () => {
  const server = scripted([50123])
  assert.equal(await listenLocal(server), 50123)
  assert.equal(server.closes, 0)
})

test('a real server ends up on a port fetch accepts', async () => {
  const server = createServer((_req, res) => res.end('ok'))
  const port = await listenLocal(server)
  try {
    assert.ok(!BLOCKED_PORTS.has(port))
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
