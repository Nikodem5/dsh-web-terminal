// Update from source: profile detection, the fixed step list, one run at a time, and failures reported.
// Spawns are faked: no git, npm or relaunch ever runs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSelfUpdate, profileOf, readSource, updateSteps } from '../lib/self-update.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-wt-update-'))
after(() => rmSync(root, { recursive: true, force: true }))

/** A profile layout with an installed copy, optionally carrying install-source.json. */
function layout(name, { source = true } = {}) {
  const home = join(root, name, '.dsh')
  const pluginDir = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-web-terminal')
  const repo = join(root, name, 'repo')
  mkdirSync(pluginDir, { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })
  if (source) writeFileSync(join(pluginDir, 'install-source.json'), JSON.stringify({ repo, commit: 'a'.repeat(40) }))
  return { home, pluginDir, repo }
}

/** Fake spawn: records calls; each child exits with `codes(call)` on the next tick and prints HEAD for rev-parse. */
function fakeSpawn(codes = () => 0) {
  const calls = []
  const spawnImpl = (file, args, options) => {
    const call = { file, args, options }
    calls.push(call)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      if (args.includes('rev-parse')) child.stdout.emit('data', args.includes('--abbrev-ref') ? 'main\n' : `${'b'.repeat(40)}\n`)
      else child.stdout.emit('data', `ran ${file}\n`)
      child.emit('close', codes(call))
    })
    return child
  }
  return { calls, spawnImpl }
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('profileOf reads home and profile from the installed path, null elsewhere', () => {
  const { home, pluginDir } = layout('profile')
  assert.deepEqual(profileOf(pluginDir), { home, profile: 'desktop' })
  assert.equal(profileOf(join(root, 'repo', 'packages', 'terminal')), null)
})

test('readSource needs install-source.json pointing at a git clone', () => {
  const { pluginDir, repo } = layout('source')
  assert.deepEqual(readSource(pluginDir), { repo, commit: 'a'.repeat(40) })
  assert.equal(readSource(layout('nosource', { source: false }).pluginDir), null)
})

test('the steps are pull, install, build and install into the profile, in that order', () => {
  const steps = updateSteps({ repo: '/r', profile: 'desktop', node: '/bin/node' })
  assert.deepEqual(steps.map((s) => s.label), ['git pull', 'npm install', 'build', 'install'])
  assert.deepEqual(steps[0].args, ['-C', '/r', 'pull', '--ff-only'])
  assert.equal(steps[3].file, '/bin/node')
  assert.deepEqual(steps[3].args.slice(1), ['desktop'])
})

test('a branch without tracking information is pulled from origin by name', () => {
  const steps = updateSteps({ repo: '/r', profile: 'desktop', node: '/bin/node', branch: 'self-update' })
  assert.deepEqual(steps[0].args, ['-C', '/r', 'pull', '--ff-only', 'origin', 'self-update'])
})

test('a branch that is not on origin skips the pull', () => {
  const steps = updateSteps({ repo: '/r', profile: 'desktop', node: '/bin/node', branch: 'self-update', pullable: false })
  assert.deepEqual(steps.map((s) => s.label), ['npm install', 'build', 'install'])
})

test('a release install reports itself unavailable and does not start', async () => {
  const { calls, spawnImpl } = fakeSpawn()
  const update = createSelfUpdate({ pluginDir: layout('release', { source: false }).pluginDir, node: () => 'node', spawnImpl })
  const status = await update.status()
  assert.equal(status.available, false)
  assert.match(status.reason, /git clone/)
  assert.equal(update.start(), false)
  assert.equal(calls.length, 0)
})

test('a run executes every step in the clone and ends ok; a second start while running is refused', async () => {
  const { pluginDir, repo } = layout('run')
  const { calls, spawnImpl } = fakeSpawn()
  const update = createSelfUpdate({ pluginDir, node: () => 'node', spawnImpl })
  assert.equal(update.start(), true)
  assert.equal(update.start(), false, 'one run at a time')
  await until(async () => (await update.status()).ok !== null)
  const status = await update.status()
  assert.equal(status.ok, true)
  assert.equal(status.running, false)
  assert.equal(status.installed, 'a'.repeat(40))
  assert.equal(status.head, 'b'.repeat(40))
  assert.equal(status.branch, 'main')
  const steps = calls.filter((c) => !c.args.includes('rev-parse'))
  assert.equal(steps.length, 4)
  assert.ok(steps.every((c) => c.options.cwd === repo))
  assert.ok(status.log.some((line) => line === '> build'))
})

test('a failing step stops the run and reports which one', async () => {
  const { calls, spawnImpl } = fakeSpawn((call) => (call.args.includes('pull') ? 1 : 0))
  const update = createSelfUpdate({ pluginDir: layout('fail').pluginDir, node: () => 'node', spawnImpl })
  update.start()
  await until(async () => (await update.status()).ok !== null)
  const status = await update.status()
  assert.equal(status.ok, false)
  assert.match(status.error, /git pull failed/)
  assert.equal(calls.filter((c) => !c.args.includes('rev-parse')).length, 1, 'nothing runs after the failure')
})

test('without node on PATH the run fails before spawning anything', async () => {
  const { calls, spawnImpl } = fakeSpawn()
  const update = createSelfUpdate({ pluginDir: layout('nonode').pluginDir, node: () => undefined, spawnImpl })
  update.start()
  await until(async () => (await update.status()).ok !== null)
  assert.match((await update.status()).error, /node was not found/)
  assert.equal(calls.filter((c) => !c.args.includes('rev-parse')).length, 0)
})

test('relaunch is refused outside the desktop app', () => {
  if (process.versions.electron !== undefined) return
  const { calls, spawnImpl } = fakeSpawn()
  const update = createSelfUpdate({ pluginDir: layout('relaunch').pluginDir, node: () => 'node', spawnImpl })
  assert.throws(() => update.relaunch(), /desktop app/)
  assert.equal(calls.length, 0)
})
