// The opt-in Antigravity integration's payloads as signals, edits and usage (pure).
//
//   node --test tests/agy-signals.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agyEditOf, agyHookSignal, agySessionOf, agyStatusSignal } from '../lib/providers/antigravity-signals.js'
import { bucketKind, createAntigravityUsage } from '../lib/providers/antigravity-usage.js'
import { createEdits } from '../lib/edits.js'

const ID = 'b5122a04-b51c-4cce-bcf6-f8369dd0f084'
// Shapes captured from agy 1.5.3 (a live -p run with workspace hooks).
const common = { artifactDirectoryPath: 'C:/x', conversationId: ID, lastUserInput: 'secret prompt', modelName: 'gemini-3.8-flash-low', transcriptPath: 'C:/x/t.jsonl', workspacePaths: ['C:/w'] }
const postTool = { ...common, error: '', stepIdx: 3, toolCall: { args: { Content: 'hi', Path: 'C:\\w\\hello.txt' }, name: 'write_file' } }
const stop = { ...common, error: '', executionNum: 0, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }

test('hook events map to states and carry the conversation id', () => {
  assert.deepEqual(agyHookSignal({ event: 'SessionStart', payload: common }), { session: ID, signal: { state: 'idle', detail: '' } })
  assert.equal(agyHookSignal({ event: 'PreInvocation', payload: common }).signal.state, 'working')
  assert.deepEqual(agyHookSignal({ event: 'PostToolUse', payload: postTool }).edit, { path: 'C:\\w\\hello.txt', tool: 'write_file' })
  assert.deepEqual(agyHookSignal({ event: 'Stop', payload: stop }).signal, { state: 'finished', detail: '' })
  assert.deepEqual(agyHookSignal({ event: 'Stop', payload: { ...stop, error: 'quota exceeded' } }).signal, { state: 'failed', detail: 'quota exceeded' })
  assert.equal(agyHookSignal({ event: 'Stop', payload: { ...stop, terminationReason: 'error' } }).signal.state, 'failed')
  assert.deepEqual(agyHookSignal({ event: 'PostInvocation', payload: common }), { session: ID })
  for (const bad of [null, [], 'x', {}, { event: 'Stop' }]) assert.doesNotThrow(() => agyHookSignal(bad))
})

test('edits: write tools only, both argument names, never a failed call or a read', () => {
  assert.deepEqual(agyEditOf({ toolCall: { name: 'replace_file_content', args: { TargetFile: '/a/b.ts' } } }), { path: '/a/b.ts', tool: 'replace_file_content' })
  assert.equal(agyEditOf({ toolCall: { name: 'view_file', args: { AbsolutePath: '/a/b.ts' } } }), undefined)
  assert.equal(agyEditOf({ toolCall: { name: 'run_command', args: { CommandLine: 'rm x' } } }), undefined)
  assert.equal(agyEditOf({ ...postTool, error: 'denied' }), undefined)
  assert.equal(agyEditOf({ toolCall: { name: 'write_file', args: null } }), undefined)
  const edits = createEdits()
  assert.equal(edits.record('C:\\w\\hello.txt', 'write_file'), true)
  assert.equal(edits.record('relative.txt', 'write_file'), false)
  assert.deepEqual(edits.list().map((e) => [e.path, e.tool]), [['C:\\w\\hello.txt', 'write_file']])
})

test('unsafe conversation ids are dropped', () => {
  assert.equal(agySessionOf({ conversationId: 'x; rm -rf /' }), undefined)
  assert.equal(agySessionOf({ conversation_id: ID }), ID)
})

test('status line: state changes only, idle after a turn is finished, confirmation is needs-you', () => {
  const p = (extra) => ({ conversation_id: ID, agent_state: 'idle', ...extra })
  assert.deepEqual(agyStatusSignal(p(), undefined), { session: ID, signal: { state: 'idle', detail: '' } })
  assert.equal(agyStatusSignal(p(), { state: 'idle' }).signal, undefined, 'unchanged')
  assert.equal(agyStatusSignal(p({ agent_state: 'tool_use' }), { state: 'idle' }).signal.state, 'working')
  assert.equal(agyStatusSignal(p({ agent_state: 'reviewing' }), { state: 'working' }).signal, undefined)
  assert.equal(agyStatusSignal(p({ agent_state: 'tool_use', tool_confirmation_pending: true }), { state: 'working' }).signal.state, 'needs-you')
  assert.equal(agyStatusSignal(p(), { state: 'working' }).signal.state, 'finished')
  assert.equal(agyStatusSignal(p(), { state: 'finished' }).signal, undefined, 'the Stop hook already said so')
  assert.equal(agyStatusSignal(p({ agent_state: 'initializing' }), undefined).signal, undefined)
  assert.deepEqual(agyStatusSignal(p({ agent_state: 'authenticating' }), undefined).signal, { state: 'needs-you', detail: 'Sign-in', kind: 'auth' })
  assert.equal(agyStatusSignal(p({ agent_state: 'error' }), { state: 'working' }).signal.state, 'failed')
})

// The status-line JSON as agy documents it (and as captured in a user's debug file), email left out here.
const statusBody = (fiveRemaining, weekRemaining, usd, now = Date.now()) => ({
  conversation_id: ID,
  plan_tier: 'Google AI Pro',
  context_window: { total_input_tokens: 84973, total_output_tokens: 36278 },
  cost: { total_usd: usd, subagent_usd: 0, estimated: true },
  quota: {
    'gemini-5h': { remaining_fraction: fiveRemaining, reset_time: new Date(now + 3 * 3600_000).toISOString(), reset_in_seconds: 10800 },
    '3p-5h': { remaining_fraction: 1, reset_time: new Date(now + 4 * 3600_000).toISOString() },
    'gemini-weekly': { remaining_fraction: weekRemaining, reset_time: new Date(now + 5 * 86400_000).toISOString() },
    'gone-weekly': { remaining_fraction: 0.5, reset_time: new Date(now + 5 * 86400_000).toISOString(), disabled: true },
    'other': { remaining_amount: 3, reset_time: new Date(now + 3600_000).toISOString() },
  },
  email: 'someone@example.com',
})

test('usage: buckets, worst of each period, cost and session tokens; email is never kept', () => {
  assert.equal(bucketKind('gemini-5h'), 'fiveHour')
  assert.equal(bucketKind('gemini-argon-wtu-weekly'), 'sevenDay')
  assert.equal(bucketKind('other'), undefined)
  const u = createAntigravityUsage()
  assert.equal(u.ingest('t1', statusBody(0.6, 0.9, 1.25)), true)
  u.ingest('t2', { ...statusBody(0.6, 0.9, 0.75), context_window: { total_input_tokens: 10, total_output_tokens: 5 } })
  const s = u.stats()
  assert.equal(s.limits.fiveHour.usedPct, 40)
  assert.equal(s.limits.fiveHour.bucket, 'gemini-5h')
  assert.equal(Math.round(s.limits.sevenDay.usedPct), 10)
  assert.deepEqual(s.limits.buckets.map((b) => b.id), ['3p-5h', 'gemini-5h', 'gemini-weekly'])
  assert.deepEqual(s.cost, { totalUsd: 2, terminals: 2, estimated: true })
  assert.equal(s.tokens.total, 84973 + 36278 + 15)
  assert.equal(s.plan, 'Google AI Pro')
  assert.doesNotMatch(JSON.stringify(u.serialize()), /example\.com/)
  u.removeSession('t2')
  assert.equal(u.stats().cost.terminals, 1)
})

test('usage: forecast, persistence, and garbage tolerated', () => {
  const start = Date.parse('2026-11-10T10:00:00Z')
  let clock = start
  const reset = new Date(start + 3 * 3600_000).toISOString()
  const body = (remaining) => ({ quota: { 'gemini-5h': { remaining_fraction: remaining, reset_time: reset } } })
  const u = createAntigravityUsage({ now: () => clock })
  u.ingest('t', body(0.9))
  clock += 3600_000
  u.ingest('t', body(0.5))
  // 10 % -> 50 % in an hour: 40 %/h, so the other 50 % last 1.25 h, before the reset.
  assert.equal(u.stats().limits.fiveHour.outAt, clock + 1.25 * 3600_000)
  const again = createAntigravityUsage({ now: () => clock })
  again.restore(JSON.parse(JSON.stringify(u.serialize())))
  assert.equal(again.stats().limits.fiveHour.usedPct, 50)
  assert.equal(again.stats().cost.terminals, 0, 'per-session numbers are not restored')
  for (const bad of [null, 'x', [], { quota: 'x' }, { quota: { a: null } }]) assert.doesNotThrow(() => u.ingest('t', bad))
  assert.doesNotThrow(() => again.restore({ buckets: { 'bad id!': { usedPct: 1, resetsAt: 1, samples: [] } } }))
})
