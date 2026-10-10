// A real cordis ctx THROWS on any property that was not injected; the host must only touch webServer and effect,
// register the WebSocket connection listener before the upgrade route, and survive optional pieces failing.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'
import { cleanup, startHost, strictCtx, tempDir } from './helpers/harness.mjs'

after(cleanup)

test('plugin identity and inject list', () => {
  assert.equal(name, 'code-editor')
  assert.deepEqual(inject, ['webServer'])
})

test('a normal apply() with a strict ctx logs no warnings and registers every route', async () => {
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let host
  try {
    host = await startHost()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(warnings, [])
  for (const p of ['/roots', '/tree', '/files', '/file', '/git/status', '/git/diff', '/git/stage', '/git/unstage', '/git/discard']) {
    assert.ok(host.routes.has(`/api/dsh-code-editor${p}`), p)
  }
  assert.equal(host.order.at(-1), 'upgrade', 'the upgrade route is registered last')
})

test('every route failing to register still leaves the upgrade registered, with warnings', () => {
  const warnings = []
  const warn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  const upgrades = []
  const teardowns = []
  try {
    apply(
      strictCtx({
        webServer: {
          register: (route) => {
            throw new Error(`duplicate exact route "${route.path}"`)
          },
          registerUpgrade: (r) => {
            upgrades.push(r)
            return () => {}
          },
        },
        effect: (fn) => {
          teardowns.push(fn())
          return () => {}
        },
      }),
      { dir: tempDir() },
    )
  } finally {
    console.warn = warn
  }
  assert.equal(upgrades.length, 1)
  assert.ok(warnings.some((w) => w.includes('[code-editor]') && w.includes('/api/dsh-code-editor/file')), warnings.join('\n'))
  for (const t of teardowns) t()
})

test('a socket connects (listener is attached before the upgrade route)', async () => {
  const host = await startHost()
  const root = tempDir()
  await host.register(root)
  const socket = await host.socket(root)
  await socket.opened
  await (await import('./helpers/harness.mjs')).waitFor(() => socket.frames.length > 0, { label: 'hello frame' })
  assert.deepEqual(socket.frames[0], { type: 'hello', root })
})

test('method, content-type and body-size policing', async () => {
  const host = await startHost()
  const root = tempDir()
  await host.register(root)
  assert.equal((await host.call('DELETE', '/file', { query: { root, path: 'a' } })).status, 405)
  assert.equal((await host.call('POST', '/roots', { rawBody: '{"roots":[]}', contentType: 'text/plain' })).status, 415)
  assert.equal((await host.call('POST', '/roots', { rawBody: '{nope' })).status, 400)
  assert.equal((await host.call('POST', '/roots', { rawBody: '[]' })).status, 400)
  const big = await host.call('PUT', '/file', { body: { root, path: 'big.txt', content: 'x'.repeat(4 * 1024 * 1024 + 100 * 1024), expectedMtime: null } })
  assert.equal(big.status, 413)
  const justOver = await host.put('/file', { root, path: 'over.txt', content: 'x'.repeat(4 * 1024 * 1024 + 1), expectedMtime: null })
  assert.equal(justOver.status, 413)
  assert.equal(justOver.json.code, 'too-large')
  assert.equal(justOver.headers.get('cache-control'), 'no-store')
})

test('a foreign Origin is refused on HTTP routes too', async () => {
  const host = await startHost()
  const root = tempDir()
  await host.register(root)
  const refused = await host.get('/tree', { root, dir: '' }, { origin: 'https://evil.example' })
  assert.equal(refused.status, 403)
  assert.equal(refused.json.code, 'origin')
  const ok = await host.get('/tree', { root, dir: '' }, { origin: `http://127.0.0.1:${host.port}` })
  assert.equal(ok.status, 200)
})
