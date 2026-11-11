// The opt-in Antigravity integration: what it writes, how it installs and removes the agy plugin (a fake
// agy), and the hook / status-line scripts agy would run, against a fake host. Never touches ~/.gemini.
//
//   node --test tests/agy-integration.test.mjs

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGY_PLUGIN_NAME, buildAgyHooks, buildAgySettings, createAgyIntegration } from '../lib/agy-integration.js'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const root = mkdtempSync(join(tmpdir(), 'dsh-agy-integration-'))
after(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const fresh = (name) => mkdtempSync(join(root, `${name}${++n}-`))

/** A fake `agy plugin install|uninstall` that copies into / deletes from the fake gemini dir. */
function fakeAgy(gemini, { fail = false } = {}) {
  const calls = []
  const run = async (argv) => {
    calls.push(argv.slice(1))
    if (fail) return { code: 1, out: 'Error: something broke\n' }
    const dest = join(gemini, 'config', 'plugins', AGY_PLUGIN_NAME)
    if (argv[2] === 'install') {
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'plugin.json'), readFileSync(join(argv[3], 'plugin.json')))
    } else if (argv[2] === 'uninstall') rmSync(dest, { recursive: true, force: true })
    return { code: 0, out: 'ok' }
  }
  return { calls, run }
}

const make = (extra = {}) => {
  const dir = fresh('data')
  const gemini = fresh('gemini')
  const agy = fakeAgy(gemini, extra)
  const integration = createAgyIntegration({ dir, geminiDir: gemini, pid: 4242, nodePath: '/bin/node', findAgy: async () => '/bin/agy', run: agy.run, version: '9.9.9', ...extra })
  return { dir, gemini, agy, integration }
}

test('hooks.json: one named group, quote-free commands run from the plugin folder', () => {
  const hooks = buildAgyHooks()
  const group = hooks[AGY_PLUGIN_NAME]
  assert.deepEqual(Object.keys(group), ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop'])
  assert.equal(group.PostToolUse[0].matcher, '*')
  assert.equal(group.PostToolUse[0].hooks[0].command, 'node hook.mjs PostToolUse')
  assert.equal(group.Stop[0].command, 'node hook.mjs Stop')
  assert.doesNotMatch(JSON.stringify(hooks), /\\"/)
})

test('--settings: the wrapper path without quotes; the user\'s own layout kept; refused with spaces', () => {
  assert.deepEqual(buildAgySettings('C:\\p\\lib\\agy-statusline.mjs', undefined), { statusLine: { type: 'command', command: 'node C:/p/lib/agy-statusline.mjs', stack_with_default: true } })
  assert.deepEqual(buildAgySettings('/p/agy-statusline.mjs', { command: 'x', padding: 1, stackWithDefault: false }), { statusLine: { type: 'command', command: 'node /p/agy-statusline.mjs', padding: 1, stack_with_default: false } })
  assert.equal(buildAgySettings('C:\\Program Files\\x.mjs', undefined), undefined)
})

test('nothing happens until install; install stages, runs agy and turns the launch settings on; remove undoes it', async () => {
  const { dir, gemini, agy, integration } = make()
  assert.deepEqual(integration.launch(), {})
  assert.equal(integration.status().enabled, false)
  assert.deepEqual(agy.calls, [])
  assert.equal(existsSync(join(dir, 'agy-plugin')), false)

  const after = await integration.install()
  assert.equal(after.error, null)
  assert.equal(after.enabled, true)
  assert.equal(after.pluginInstalled, true)
  assert.equal(after.reason, null)
  assert.deepEqual(agy.calls, [['plugin', 'install', join(dir, 'agy-plugin')]])
  for (const file of ['plugin.json', 'hooks.json', 'hook.mjs']) assert.ok(existsSync(join(dir, 'agy-plugin', file)), file)
  assert.equal(JSON.parse(readFileSync(join(dir, 'agy-plugin', 'plugin.json'), 'utf8')).version, '9.9.9')
  const { settingsPath } = integration.launch()
  assert.equal(settingsPath, join(dir, 'agy-settings-4242.json'))
  assert.match(JSON.parse(readFileSync(settingsPath, 'utf8')).statusLine.command, /^node \S+\/agy-statusline\.mjs$/)

  const removed = await integration.remove()
  assert.equal(removed.enabled, false)
  assert.equal(removed.pluginInstalled, false)
  assert.deepEqual(agy.calls.at(-1), ['plugin', 'uninstall', AGY_PLUGIN_NAME])
  assert.deepEqual(integration.launch(), {})
  assert.equal(existsSync(settingsPath), false)
  assert.equal(existsSync(join(dir, 'agy-plugin')), false)
  assert.equal(existsSync(join(gemini, 'config', 'plugins', AGY_PLUGIN_NAME)), false)
})

test('a failed install leaves it off and says why; no node or no agy refuses', async () => {
  const failing = make({ fail: true })
  const s = await failing.integration.install()
  assert.equal(s.enabled, false)
  assert.match(s.error, /^agy plugin install failed: Error: something broke$/)
  assert.deepEqual(failing.integration.launch(), {})

  const noNode = make({ nodePath: undefined })
  assert.match((await noNode.integration.install()).error, /node is not on PATH/)
  assert.deepEqual(noNode.agy.calls, [])

  const dir = fresh('data')
  const noAgy = createAgyIntegration({ dir, geminiDir: fresh('gemini'), pid: 1, nodePath: '/bin/node', findAgy: async () => undefined })
  assert.match((await noAgy.install()).error, /not found on PATH/)
})

test('settings files of dead hosts are swept; dispose removes this host\'s', async () => {
  const { dir, integration } = make()
  await integration.install()
  writeFileSync(join(dir, 'agy-settings-1.json'), '{}')
  createAgyIntegration({ dir, geminiDir: fresh('g'), pid: 4242, nodePath: '/bin/node', findAgy: async () => undefined, pidAlive: () => false })
  assert.equal(existsSync(join(dir, 'agy-settings-1.json')), false)
  integration.launch()
  integration.dispose()
  assert.equal(existsSync(join(dir, 'agy-settings-4242.json')), false)
})

// ── the scripts agy runs ──

/** A fake host signal server that records posts. */
async function fakeHost() {
  const posts = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      posts.push({ url: req.url, token: req.headers['x-dsh-wt-token'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      res.writeHead(204)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { posts, base: `http://127.0.0.1:${server.address().port}/signal`, close: () => server.close() }
}

/** Run a script like agy does: JSON on stdin; resolves with stdout and the exit code. */
function runScript(file, args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, DSH_WT_TOKEN: '', DSH_WT_AGY_SIGNAL: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ out, code }))
    child.stdin.end(input)
  })
}

test('hook.mjs forwards the event with the secret, keeps only what the host reads, and always prints {}', async () => {
  const host = await fakeHost()
  try {
    const payload = { conversationId: 'b5122a04-b51c-4cce-bcf6-f8369dd0f084', lastUserInput: 'private prompt', toolCall: { name: 'write_file', args: { Path: 'C:\\a.txt' } }, error: '' }
    const done = await runScript(join(lib, 'agy-hook.mjs'), ['PostToolUse'], JSON.stringify(payload), { DSH_WT_TOKEN: 'tok', DSH_WT_AGY_SIGNAL: host.base })
    assert.deepEqual(done, { out: '{}', code: 0 })
    assert.equal(host.posts.length, 1)
    assert.equal(host.posts[0].url, '/signal/antigravity-hook')
    assert.equal(host.posts[0].token, 'tok')
    assert.equal(host.posts[0].body.event, 'PostToolUse')
    assert.deepEqual(host.posts[0].body.payload.toolCall, payload.toolCall)
    assert.equal(host.posts[0].body.payload.lastUserInput, undefined, 'the prompt never leaves agy')

    // Outside a terminal the plugin opened: nothing is sent, still `{}`.
    assert.deepEqual(await runScript(join(lib, 'agy-hook.mjs'), ['Stop'], '{}', {}), { out: '{}', code: 0 })
    assert.equal(host.posts.length, 1)
    // Garbage on stdin is tolerated.
    assert.deepEqual(await runScript(join(lib, 'agy-hook.mjs'), ['Stop'], 'not json', { DSH_WT_TOKEN: 'tok', DSH_WT_AGY_SIGNAL: host.base }), { out: '{}', code: 0 })
  } finally {
    host.close()
  }
})

test('agy-statusline.mjs shares the Claude wrapper runUser, which kills a hung command with everything it started', async () => {
  const { runUser: claudeRunUser } = await import('../lib/statusline.js')
  const { runUser } = await import('../lib/agy-statusline.mjs')
  assert.equal(runUser, claudeRunUser, 'one implementation, not a copy')
  const pidFile = join(root, 'agy-grandchild.pid')
  const file = join(root, 'agy-hang.js')
  writeFileSync(file, `const { spawn } = require('node:child_process')
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))
setInterval(() => {}, 1000)`)
  assert.equal(await runUser(`node "${file.replaceAll('\\', '/')}"`, '{}', 'DSH_WT_AGY_STATUSLINE', 1500), '')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  const deadline = Date.now() + 10_000
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  if (alive()) { try { process.kill(pid) } catch {} }
  assert.equal(alive(), false, 'the grandchild must not survive the timeout')
})

test('agy-statusline.mjs posts the payload and relays the user\'s own status line', async () => {
  const host = await fakeHost()
  const gemini = fresh('gemini')
  mkdirSync(join(gemini, 'antigravity-cli'), { recursive: true })
  const userScript = join(gemini, 'mine.mjs')
  writeFileSync(userScript, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('MINE '+JSON.parse(s).agent_state))")
  writeFileSync(join(gemini, 'antigravity-cli', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node ${userScript.replaceAll('\\', '/')}` } }))
  try {
    const body = JSON.stringify({ agent_state: 'idle', conversation_id: 'b5122a04-b51c-4cce-bcf6-f8369dd0f084' })
    const done = await runScript(join(lib, 'agy-statusline.mjs'), [], body, { DSH_WT_TOKEN: 'tok', DSH_WT_AGY_SIGNAL: host.base, DSH_WT_GEMINI_DIR: gemini, DSH_WT_POST_TIMEOUT_MS: '5000' })
    assert.deepEqual(done, { out: 'MINE idle', code: 0 })
    assert.equal(host.posts.length, 1)
    assert.equal(host.posts[0].url, '/signal/antigravity-status')
    assert.equal(host.posts[0].body.agent_state, 'idle')
    // No status line of their own: prints nothing (the built-in one stays, stack_with_default).
    const bare = fresh('gemini')
    assert.deepEqual(await runScript(join(lib, 'agy-statusline.mjs'), [], body, { DSH_WT_GEMINI_DIR: bare }), { out: '', code: 0 })
  } finally {
    host.close()
  }
})
