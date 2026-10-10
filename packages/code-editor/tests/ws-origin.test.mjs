import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, startHost, tempDir, waitFor } from './helpers/harness.mjs'

after(cleanup)

async function outcome(host, root, origin, path) {
  const socket = await host.socket(root, { origin, path })
  try {
    await socket.opened
    await waitFor(() => socket.frames.length > 0, { label: 'hello' })
    socket.close()
    return { open: true, hello: socket.frames[0] }
  } catch (error) {
    return { open: false, status: error.status }
  }
}

test('origin policy: no Origin, the harness own origin, dsh-app and loopback aliases pass; foreign sites fail', async () => {
  const host = await startHost()
  const root = tempDir()
  await host.register(root)
  const own = `http://127.0.0.1:${host.port}`
  for (const origin of [undefined, own, `http://localhost:${host.port}`, `http://[::1]:${host.port}`, 'dsh-app://app']) {
    assert.equal((await outcome(host, root, origin)).open, true, String(origin))
  }
  for (const origin of ['https://evil.example', 'http://localhost:9', `http://127.0.0.1:${host.port + 1}`, 'null', 'file://', `http://evil.example:${host.port}`]) {
    const result = await outcome(host, root, origin)
    assert.deepEqual([origin, result.open, result.status], [origin, false, 403])
  }
})

test('DSH_CE_ALLOWED_ORIGINS extends the allowlist', async () => {
  process.env.DSH_CE_ALLOWED_ORIGINS = 'https://harness.example.com'
  try {
    const host = await startHost()
    const root = tempDir()
    await host.register(root)
    assert.equal((await outcome(host, root, 'https://harness.example.com')).open, true)
    assert.equal((await outcome(host, root, 'https://other.example.com')).open, false)
  } finally {
    delete process.env.DSH_CE_ALLOWED_ORIGINS
  }
})

test('a socket for an unregistered, relative or missing root is refused before the handshake', async () => {
  const host = await startHost()
  const root = tempDir()
  assert.equal((await outcome(host, root)).status, 403)
  await host.register(root)
  assert.equal((await outcome(host, root)).open, true)
  assert.equal((await outcome(host, 'relative/path')).status, 403)
  assert.equal((await outcome(host, '')).status, 400)
  assert.equal((await outcome(host, `${root}/..`)).status, 403)
})
