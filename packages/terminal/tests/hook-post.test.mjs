// The command-hook forwarder SessionStart uses: posts stdin to the host, prints nothing, never fails.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The wrapper's post gives up after 500 ms; a loaded machine can be slower than that, so the tests allow far longer.
process.env.DSH_WT_POST_TIMEOUT_MS = '20000'
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'hook-post.js')

async function listener() {
  const posts = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      posts.push({ url: req.url, token: req.headers['x-dsh-wt-token'], body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { posts, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

function run(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, DSH_WT_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('close', (code) => resolve({ out, err, code }))
    child.stdin.end(input)
  })
}

const body = JSON.stringify({ hook_event_name: 'SessionStart', session_id: '3f4a3c42-a672-45ff-a7f5-ac6abdc48a8e', source: 'startup' })

test('posts stdin to the url with the token header and prints nothing', async () => {
  const host = await listener()
  const { out, err, code } = await run([`${host.base}/signal/claude`], { DSH_WT_TOKEN: 'tok' }, body)
  host.close()
  assert.equal(code, 0)
  assert.equal(out, '', 'SessionStart stdout would be added to the model context')
  assert.equal(err, '')
  assert.deepEqual(host.posts, [{ url: '/signal/claude', token: 'tok', body }])
})

test('stays silent and exits 0 without a token, with a bad or non-loopback url, or with nothing listening', async () => {
  const host = await listener()
  const cases = [
    [[`${host.base}/signal/claude`], {}],
    [['not a url'], { DSH_WT_TOKEN: 't' }],
    [[`${host.base}/signal/claude`.replace('127.0.0.1', 'localhost')], { DSH_WT_TOKEN: 't' }],
    [['http://127.0.0.1:1/signal/claude'], { DSH_WT_TOKEN: 't' }],
    [[], { DSH_WT_TOKEN: 't' }],
  ]
  for (const [args, env] of cases) {
    const result = await run(args, env, body)
    assert.equal(result.code, 0)
    assert.equal(result.out, '')
    assert.equal(result.err, '')
  }
  host.close()
  assert.equal(host.posts.length, 0)
})
