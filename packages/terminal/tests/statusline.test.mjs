// The status-line wrapper: posts the payload to the host and relays the user's own status line.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { userStatusLine, userSubagentStatusLine } from '../lib/statusline.js'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'statusline.js')
const root = mkdtempSync(join(tmpdir(), 'dsh-wt-statusline-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
// The wrapper's post gives up after 500 ms; a loaded machine can be slower than that, so the tests allow far longer.
process.env.DSH_WT_POST_TIMEOUT_MS = '20000'

/** A fake Claude config dir whose settings carry `statusLine` (when given). */
function configDir(statusLine) {
  const dir = join(root, `cfg${++n}`)
  mkdirSync(dir)
  if (statusLine !== undefined) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ statusLine }))
  return dir
}

/** A "user status line" script: prints a line built from its stdin. */
function userScript() {
  const file = join(root, `user${++n}.js`)
  writeFileSync(file, "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('USER:'+JSON.parse(s).model+'\\n'))")
  return file.replaceAll('\\', '/')
}

/** A loopback server that records what is POSTed to it. */
async function fakeHost(status = 204) {
  const posts = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      posts.push({ url: req.url, token: req.headers['x-dsh-wt-token'], body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(status)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { posts, url: `http://127.0.0.1:${server.address().port}/signal/usage`, close: () => server.close() }
}

/** Run the wrapper; resolves with its stdout and exit code. */
function run({ args = [], env = {}, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, DSH_WT_TOKEN: '', DSH_WT_STATUSLINE: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ out, code }))
    child.stdin.end(input)
  })
}

const payload = JSON.stringify({ model: 'opus', rate_limits: { five_hour: { used_percentage: 3, resets_at: 99 } } })

test('posts the raw payload with the token and relays the user status line', async () => {
  const host = await fakeHost()
  const cfg = configDir({ type: 'command', command: `node "${userScript()}"`, refreshInterval: 3 })
  const { out, code } = await run({ args: [host.url], env: { DSH_WT_TOKEN: 'secret-1', CLAUDE_CONFIG_DIR: cfg }, input: payload })
  host.close()
  assert.equal(code, 0)
  assert.equal(out, 'USER:opus\n')
  assert.deepEqual(host.posts, [{ url: '/signal/usage', token: 'secret-1', body: payload }])
})

test('no token: nothing is posted but the user line still shows', async () => {
  const host = await fakeHost()
  const cfg = configDir({ type: 'command', command: `node "${userScript()}"` })
  const { out, code } = await run({ args: [host.url], env: { CLAUDE_CONFIG_DIR: cfg }, input: payload })
  host.close()
  assert.equal(code, 0)
  assert.equal(out, 'USER:opus\n')
  assert.equal(host.posts.length, 0)
})

test('no user status line prints nothing; a dead host still exits 0', async () => {
  const cfg = configDir()
  const result = await run({ args: ['http://127.0.0.1:1/signal/usage'], env: { DSH_WT_TOKEN: 't', CLAUDE_CONFIG_DIR: cfg }, input: payload })
  assert.deepEqual(result, { out: '', code: 0 })
  const notCommand = configDir({ type: 'static', command: 'echo hi' })
  assert.equal((await run({ args: [], env: { CLAUDE_CONFIG_DIR: notCommand }, input: payload })).out, '')
})

test('the token is only ever sent to loopback', async () => {
  const host = await fakeHost()
  const evil = host.url.replace('127.0.0.1', 'localhost')
  await run({ args: [evil], env: { DSH_WT_TOKEN: 'secret', CLAUDE_CONFIG_DIR: configDir() }, input: payload })
  host.close()
  assert.equal(host.posts.length, 0)
})

test('recursion guard: a user command that is this wrapper, or runs under it, is skipped', async () => {
  const host = await fakeHost()
  // The user command points back at a statusline.js: it would loop, so it is not run.
  const self = configDir({ type: 'command', command: `node "${script.replaceAll('\\', '/')}" ${host.url}` })
  const a = await run({ args: [host.url], env: { DSH_WT_TOKEN: 't', CLAUDE_CONFIG_DIR: self }, input: payload })
  assert.equal(a.out, '')
  assert.equal(host.posts.length, 1, 'only the outer run posted')
  // Already running under a wrapper (marker set): the user command is not run again.
  const cfg = configDir({ type: 'command', command: `node "${userScript()}"` })
  const b = await run({ args: [host.url], env: { DSH_WT_TOKEN: 't', CLAUDE_CONFIG_DIR: cfg, DSH_WT_STATUSLINE: '1' }, input: payload })
  host.close()
  assert.equal(b.out, '')
})

test('userStatusLine reads the command and refresh interval, ignoring anything else', () => {
  assert.deepEqual(userStatusLine({ CLAUDE_CONFIG_DIR: configDir({ type: 'command', command: 'x', refreshInterval: 7 }) }), { command: 'x', refreshInterval: 7 })
  assert.deepEqual(userStatusLine({ CLAUDE_CONFIG_DIR: configDir({ type: 'command', command: 'x', refreshInterval: 'a' }) }), { command: 'x', refreshInterval: undefined })
  assert.equal(userStatusLine({ CLAUDE_CONFIG_DIR: configDir({ type: 'command', command: '  ' }) }), undefined)
  assert.equal(userStatusLine({ CLAUDE_CONFIG_DIR: join(root, 'missing') }), undefined)
})

// ── sub-agent mode ──

/** A fake Claude config dir whose settings carry `subagentStatusLine`. */
function subagentConfigDir(subagentStatusLine) {
  const dir = join(root, `cfg${++n}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ subagentStatusLine, statusLine: { type: 'command', command: 'echo not-me' } }))
  return dir
}

const subPayload = JSON.stringify({ model: 'opus', tasks: [{ id: 'a1', status: 'running', tokenCount: 5 }] })

test('--subagents posts the payload and prints nothing without a user command', async () => {
  const host = await fakeHost()
  const { out, code } = await run({ args: ['--subagents', host.url], env: { DSH_WT_TOKEN: 'tok', CLAUDE_CONFIG_DIR: configDir({ type: 'command', command: 'echo main-line' }) }, input: subPayload })
  host.close()
  assert.equal(code, 0)
  assert.equal(out, '', 'Claude keeps its default rows')
  assert.equal(host.posts.length, 1)
  assert.equal(host.posts[0].token, 'tok')
  assert.equal(host.posts[0].body, subPayload)
})

test("--subagents relays the user's own subagentStatusLine, not their main status line", async () => {
  const host = await fakeHost()
  const cfg = subagentConfigDir({ type: 'command', command: `node "${userScript()}"` })
  const { out } = await run({ args: ['--subagents', host.url], env: { DSH_WT_TOKEN: 'tok', CLAUDE_CONFIG_DIR: cfg }, input: subPayload })
  host.close()
  assert.equal(out.trim(), 'USER:opus')
  assert.equal(host.posts.length, 1)
})

test('--subagents recursion guard: a user command that is this wrapper, or already runs under one, is skipped', async () => {
  const host = await fakeHost()
  const self = subagentConfigDir({ type: 'command', command: `node "${script.replaceAll('\\', '/')}" --subagents ${host.url}` })
  const a = await run({ args: ['--subagents', host.url], env: { DSH_WT_TOKEN: 't', CLAUDE_CONFIG_DIR: self }, input: subPayload })
  assert.equal(a.out, '')
  assert.equal(host.posts.length, 1)
  const cfg = subagentConfigDir({ type: 'command', command: `node "${userScript()}"` })
  const b = await run({ args: ['--subagents', host.url], env: { DSH_WT_TOKEN: 't', CLAUDE_CONFIG_DIR: cfg, DSH_WT_SUBAGENTLINE: '1' }, input: subPayload })
  host.close()
  assert.equal(b.out, '')
})

test('userSubagentStatusLine reads only the subagentStatusLine command', () => {
  assert.deepEqual(userSubagentStatusLine({ CLAUDE_CONFIG_DIR: subagentConfigDir({ type: 'command', command: 'x' }) }), { command: 'x', refreshInterval: undefined })
  assert.equal(userSubagentStatusLine({ CLAUDE_CONFIG_DIR: configDir({ type: 'command', command: 'x' }) }), undefined)
})
