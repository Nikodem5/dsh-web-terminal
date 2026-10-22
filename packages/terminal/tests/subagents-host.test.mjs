// The pure sub-agent store: merges status-line tasks with Start/Stop hooks, retains, caps, validates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSubagents, MAX_SUBAGENTS, RETAIN_MS } from '../lib/subagents.js'

function store(options) {
  const clock = { t: 1_000_000 }
  const s = createSubagents({ now: () => clock.t, ...options })
  return { s, clock }
}

const task = (over = {}) => ({ id: 'a1', type: 'local_agent', agentType: 'Explore', status: 'running', description: 'Look around', label: 'Look', startTime: 5000, model: 'claude-haiku-5-5', contextWindowSize: 1000000, tokenCount: 10, tokenSamples: [1, 2], ...over })

test('status-line tasks become SubagentInfo with exactly the contract fields', () => {
  const { s } = store()
  assert.equal(s.ingestTasks({ tasks: [task()] }), true)
  assert.deepEqual(s.list(), [{
    id: 'a1', agentType: 'Explore', label: 'Look', description: 'Look around', status: 'running', model: 'claude-haiku-5-5',
    startTime: 5000, endedAt: null, tokenCount: 10, contextWindowSize: 1000000,
  }])
})

test('an identical payload is not a change; a new token count is', () => {
  const { s } = store()
  s.ingestTasks({ tasks: [task()] })
  assert.equal(s.ingestTasks({ tasks: [task()] }), false)
  assert.equal(s.ingestTasks({ tasks: [task({ tokenCount: 99 })] }), true)
  assert.equal(s.list()[0].tokenCount, 99)
})

test('SubagentStart creates a running entry that the status line then fills in', () => {
  const { s, clock } = store()
  assert.equal(s.start({ agent_id: 'a1', agent_type: 'Plan' }), true)
  assert.deepEqual(s.list()[0], { id: 'a1', agentType: 'Plan', label: '', description: '', status: 'running', model: null, startTime: clock.t, endedAt: null, tokenCount: null, contextWindowSize: null })
  s.ingestTasks({ tasks: [task({ agentType: 'Plan' })] })
  assert.equal(s.list().length, 1)
  assert.equal(s.list()[0].model, 'claude-haiku-5-5')
})

test('SubagentStop completes it with endedAt and keeps the agent type; a late status-line tick does not revive it', () => {
  const { s, clock } = store()
  s.start({ agent_id: 'a1', agent_type: 'Explore' })
  clock.t += 1000
  assert.equal(s.stop({ agent_id: 'a1', agent_type: 'Explore', last_assistant_message: 'x'.repeat(10_000) }), true)
  const done = s.list()[0]
  assert.equal(done.status, 'completed')
  assert.equal(done.endedAt, clock.t)
  assert.equal(done.agentType, 'Explore')
  clock.t += 50
  assert.equal(s.ingestTasks({ tasks: [task()] }), false)
  assert.equal(s.stop({ agent_id: 'a1' }), false, 'a second stop changes nothing')
  assert.deepEqual(s.list()[0], done)
})

test('a stop for an agent never seen is ignored, so no nameless 0s row appears', () => {
  const { s } = store()
  assert.equal(s.stop({ agent_id: 'zz', agent_type: 'Plan' }), false)
  assert.deepEqual(s.list(), [])
})

test('a status-line task reporting a finished status ends the agent', () => {
  const { s, clock } = store()
  s.ingestTasks({ tasks: [task({ status: 'completed' })] })
  assert.equal(s.list()[0].endedAt, clock.t)
})

test('finished agents are dropped after the retention, running ones never', () => {
  const { s, clock } = store()
  s.start({ agent_id: 'run' })
  s.start({ agent_id: 'fin' })
  s.stop({ agent_id: 'fin' })
  clock.t += RETAIN_MS - 1
  assert.equal(s.prune(), false)
  assert.equal(s.list().length, 2)
  clock.t += 1
  assert.equal(s.prune(), true)
  assert.deepEqual(s.list().map((a) => a.id), ['run'])
})

test('endAll completes every running agent once', () => {
  const { s, clock } = store()
  s.start({ agent_id: 'a' })
  s.start({ agent_id: 'b' })
  s.stop({ agent_id: 'b' })
  clock.t += 10
  assert.equal(s.endAll(), true)
  assert.ok(s.list().every((a) => a.status === 'completed' && a.endedAt !== null))
  assert.equal(s.endAll(), false)
})

test('the list is capped, dropping finished agents before running ones', () => {
  const { s } = store({ max: 3 })
  for (const id of ['a', 'b', 'c']) s.start({ agent_id: id })
  s.stop({ agent_id: 'b' })
  s.start({ agent_id: 'd' })
  assert.deepEqual(s.list().map((a) => a.id), ['a', 'c', 'd'])
  s.start({ agent_id: 'e' })
  assert.deepEqual(s.list().map((a) => a.id), ['c', 'd', 'e'], 'all running: the oldest goes')
  assert.equal(MAX_SUBAGENTS, 50)
})

test('untrusted fields are validated and size-limited', () => {
  const { s } = store()
  s.ingestTasks({
    tasks: [
      null, 'x', 7, { id: 42 }, { id: '../etc' }, { id: '' }, { id: 'a'.repeat(200) },
      { id: 'ok', description: `  a\n\n  ${'b'.repeat(500)}`, label: { x: 1 }, agentType: 5, model: ['m'], startTime: 'now', tokenCount: Infinity, contextWindowSize: -1, status: 7 },
    ],
  })
  const [a, ...rest] = s.list()
  assert.equal(rest.length, 0)
  assert.equal(a.id, 'ok')
  assert.equal(a.description.length, 200)
  assert.ok(a.description.startsWith('a bbb'))
  assert.deepEqual([a.label, a.agentType, a.model, a.status], ['', '', null, 'running'])
  assert.deepEqual([a.tokenCount, a.contextWindowSize], [null, null])
  assert.equal(typeof a.startTime, 'number')
  for (const bad of [undefined, null, 'x', [], {}, { tasks: 'no' }, { tasks: {} }]) assert.equal(s.ingestTasks(bad), false)
  assert.equal(s.start(null), false)
  assert.equal(s.start({ agent_id: ['x'] }), false)
  assert.equal(s.stop({}), false)
})
