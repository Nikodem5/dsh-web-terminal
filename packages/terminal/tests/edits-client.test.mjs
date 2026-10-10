// The browser half of "changed by agent": the runtime keeps the host's edits list and the read-only
// window.__dshTerminals API lists only open terminals, notifies on change and on close.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWebSocket, loadStore, window } from './helpers/load-store.mjs'

let s

before(async () => {
  s = await loadStore()
  s.installTerminalsApi()
})

after(() => {
  s.closeAll()
  window.close()
})

beforeEach(() => {
  s.closeAll()
  s.runtimes.clear()
  window.localStorage.clear()
  FakeWebSocket.reset()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await sleep(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

const attached = (extra = {}) => ({ type: 'attached', created: false, replay: '', exited: false, exitCode: null, agent: null, ...extra })
const edit = (path, tool = 'Edit', at = 1000) => ({ path, at, tool })

async function start(opts = {}) {
  const before = FakeWebSocket.instances.length
  const id = s.openTerminal({ cwd: 'C:\\work', ...opts })
  const rt = s.ensureRuntime(s.getWins().find((w) => w.id === id))
  s.openRuntime(rt)
  const sock = await until(() => FakeWebSocket.instances[before], 'the socket')
  return { id, rt, sock }
}

test('the API is published on window and read-only data: version 1, listEdits, subscribe', () => {
  const api = window.__dshTerminals
  assert.equal(api.version, 1)
  assert.equal(typeof api.listEdits, 'function')
  assert.equal(typeof api.subscribe, 'function')
  assert.deepEqual(api.listEdits(), [])
})

test('attached seeds the list and edits frames replace it; entries are validated', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached({ edits: [edit('C:\\work\\a.ts')] }))
  await until(() => rt.edits.length === 1, 'the attached list')
  sock.push({ type: 'edits', files: [edit('C:\\work\\a.ts', 'Write', 2000), edit('C:\\work\\b.ts'), { nope: 1 }, 'junk', edit('') ] })
  await until(() => rt.edits.length === 2, 'the frame list')
  const [entry] = window.__dshTerminals.listEdits()
  assert.equal(entry.terminalId, id)
  assert.equal(entry.live, true)
  assert.deepEqual(entry.files.map((f) => [f.path, f.tool, f.at]), [['C:\\work\\a.ts', 'Write', 2000], ['C:\\work\\b.ts', 'Edit', 1000]])
  sock.push({ type: 'edits', files: 'bad' })
  await until(() => rt.edits.length === 0, 'an invalid list clears')
  assert.deepEqual(window.__dshTerminals.listEdits(), [], 'a terminal with no files is not listed')
})

test('the name follows the window; only terminals with files are listed', async () => {
  const a = await start({ title: 'Agent A' })
  const b = await start({ title: 'Agent B' })
  a.sock.push(attached())
  b.sock.push(attached({ edits: [edit('/x/y.ts')] }))
  await until(() => b.rt.edits.length === 1, 'b list')
  const list = window.__dshTerminals.listEdits()
  assert.equal(list.length, 1)
  assert.equal(list[0].terminalId, b.id)
  assert.equal(list[0].name, s.displayName(s.getWins().find((w) => w.id === b.id)))
})

test('subscribers and the window event fire on a change and on close; closing removes the entries; unsubscribe stops it', async () => {
  const { id, rt, sock } = await start()
  sock.push(attached())
  await until(() => rt.conn === 'live', 'live')
  let calls = 0
  let events = 0
  const off = window.__dshTerminals.subscribe(() => { calls++ })
  window.addEventListener('dsh-terminals:edits', () => { events++ })
  sock.push({ type: 'edits', files: [edit('/w/a.ts')] })
  await until(() => calls === 1, 'subscriber on edits')
  assert.equal(events, 1)
  assert.equal(window.__dshTerminals.listEdits().length, 1)
  s.closeWin(id)
  assert.equal(calls, 2, 'close notifies')
  assert.deepEqual(window.__dshTerminals.listEdits(), [], 'a closed terminal leaves no entries')
  off()
  const next = await start()
  next.sock.push({ type: 'edits', files: [edit('/w/b.ts')] })
  await until(() => next.rt.edits.length === 1, 'second terminal')
  assert.equal(calls, 2, 'unsubscribed')
})

test('a subscriber that throws does not break the others', async () => {
  const { rt, sock } = await start()
  sock.push(attached())
  const seen = []
  const offBad = window.__dshTerminals.subscribe(() => { throw new Error('boom') })
  const offGood = window.__dshTerminals.subscribe(() => seen.push(1))
  sock.push({ type: 'edits', files: [edit('/w/a.ts')] })
  await until(() => seen.length === 1 && rt.edits.length === 1, 'delivery')
  offBad()
  offGood()
})
