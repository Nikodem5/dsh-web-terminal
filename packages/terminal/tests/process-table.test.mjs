// Process-table helper protocol: a fake child stands in for powershell, plus one real-PowerShell check on Windows.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createProcessTable, parseSnapshot } from '../lib/process-table.js'

/** A fake helper: records stdin writes; `reply(text)` plays stdout; `die()` plays an exit. */
function fakeChild() {
  const child = new EventEmitter()
  child.writes = []
  child.killed = false
  child.stdin = Object.assign(new EventEmitter(), {
    write(text) { child.writes.push(text); child.onWrite?.(text) },
    end() {},
  })
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  child.kill = () => { child.killed = true }
  child.reply = (text) => child.stdout.emit('data', text)
  child.die = () => child.emit('exit', 1)
  return child
}

const ROWS = JSON.stringify([{ p: 10, q: 1, n: 'Shell.EXE' }, { p: 11, q: 10, n: 'node.exe' }])

function table(extra = {}) {
  const children = []
  const clock = { t: 1_000_000 }
  const t = createProcessTable({
    platform: 'win32',
    spawnHelper: () => { const c = fakeChild(); children.push(c); return c },
    now: () => clock.t,
    idleMs: 60_000,
    timeoutMs: 60_000,
    backoffMs: 1000,
    ...extra,
  })
  return { t, children, clock }
}

/** Let the pending microtasks and the start-up of a snapshot run. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('parseSnapshot builds the parent map and lowercases names', () => {
  const map = parseSnapshot('﻿' + ROWS)
  assert.deepEqual(map.get(1), [{ pid: 10, name: 'shell.exe' }])
  assert.deepEqual(map.get(10), [{ pid: 11, name: 'node.exe' }])
  assert.equal(parseSnapshot('not json'), undefined)
  assert.equal(parseSnapshot('{"a":1}'), undefined)
})

test('one helper serves many snapshots over the line protocol', async () => {
  const { t, children } = table()
  const first = t.snapshot()
  await tick()
  assert.equal(children.length, 1)
  assert.deepEqual(children[0].writes, ['snapshot\n'])
  children[0].reply(ROWS + '\n')
  assert.equal((await first).get(10)[0].pid, 11)
  const second = t.snapshot()
  await tick()
  children[0].reply(ROWS + '\n')
  await second
  assert.equal(children.length, 1, 'helper reused')
  assert.equal(children[0].writes.length, 2)
  t.stop()
})

test('partial lines are buffered until the newline', async () => {
  const { t, children } = table()
  const p = t.snapshot()
  await tick()
  children[0].reply(ROWS.slice(0, 20))
  children[0].reply(ROWS.slice(20, 40))
  children[0].reply(ROWS.slice(40) + '\n')
  assert.equal((await p).get(1)[0].name, 'shell.exe')
  t.stop()
})

test('concurrent snapshots share one request', async () => {
  const { t, children } = table()
  const a = t.snapshot()
  const b = t.snapshot()
  await tick()
  assert.equal(children[0].writes.length, 1)
  children[0].reply(ROWS + '\n')
  assert.equal(await a, await b)
  t.stop()
})

test('a crash answers undefined, then restarts only after the backoff', async () => {
  const { t, children, clock } = table()
  const p = t.snapshot()
  await tick()
  children[0].die()
  assert.equal(await p, undefined)
  assert.equal(children[0].killed, true)
  assert.equal(await t.snapshot(), undefined, 'inside the backoff no new process is started')
  assert.equal(children.length, 1)
  clock.t += 1500
  const again = t.snapshot()
  await tick()
  assert.equal(children.length, 2)
  children[1].reply(ROWS + '\n')
  assert.ok(await again)
  t.stop()
})

test('repeated failures back off exponentially', async () => {
  const { t, children, clock } = table()
  for (const gap of [1000, 2000]) {
    const p = t.snapshot()
    await tick()
    children.at(-1).die()
    await p
    clock.t += gap - 1
    assert.equal(await t.snapshot(), undefined)
    clock.t += 1
  }
  assert.equal(children.length, 2)
  t.stop()
})

test('a response timeout kills the helper', async () => {
  const { t, children } = table({ timeoutMs: 20 })
  assert.equal(await t.snapshot(), undefined)
  assert.equal(children[0].killed, true)
  assert.equal(t.running(), false)
  t.stop()
})

test('a spawn that throws is a failure, not an exception', async () => {
  const t = createProcessTable({ platform: 'win32', spawnHelper: () => { throw new Error('ENOENT') }, backoffMs: 1000 })
  assert.equal(await t.snapshot(), undefined)
  t.stop()
})

test('oversized output without a newline restarts the helper', async () => {
  const { t, children } = table()
  const p = t.snapshot()
  await tick()
  children[0].reply('x'.repeat(8 * 1024 * 1024))
  children[0].reply('x'.repeat(9 * 1024 * 1024))
  assert.equal(await p, undefined)
  assert.equal(children[0].killed, true)
  t.stop()
})

test('the helper stops after the idle period', async () => {
  const { t, children } = table({ idleMs: 30 })
  const p = t.snapshot()
  await tick()
  children[0].reply(ROWS + '\n')
  await p
  assert.equal(t.running(), true)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(children[0].killed, true)
  assert.equal(t.running(), false)
  t.stop()
})

test('stop kills the helper, answers a pending request and refuses new ones', async () => {
  const { t, children } = table()
  const p = t.snapshot()
  await tick()
  t.stop()
  assert.equal(await p, undefined)
  assert.equal(children[0].killed, true)
  assert.equal(await t.snapshot(), undefined)
  assert.equal(children.length, 1)
})

test('real PowerShell helper answers and leaves no process after stop', { skip: process.platform !== 'win32' }, async () => {
  const t = createProcessTable({ timeoutMs: 20_000 })
  const map = await t.snapshot()
  assert.ok(map instanceof Map && map.size > 10, 'snapshot has processes')
  const mine = map.get(process.pid) ?? []
  assert.ok(mine.some((c) => c.name === 'powershell.exe'), 'the helper is our child')
  const helperPid = mine.find((c) => c.name === 'powershell.exe').pid
  t.stop()
  // Process teardown is asynchronous and slow under load: poll for the exit, with a generous deadline.
  const alive = () => execFileSync('tasklist', ['/FI', `PID eq ${helperPid}`, '/NH'], { windowsHide: true }).toString().includes(String(helperPid))
  const deadline = Date.now() + 15_000
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(!alive(), 'helper process is gone')
})
