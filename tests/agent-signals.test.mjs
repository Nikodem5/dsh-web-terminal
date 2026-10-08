// Unit tests for the provider-neutral agent signal mapping (pure functions).
//
//   npm test   (or: node --test tests/*.test.mjs)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_STATES, CLAUDE_HOOK_EVENTS, SESSION_ID, TOKEN_ENV, TOKEN_HEADER, buildClaudeSettings, claudeAdapter, normalizeSignal } from '../lib/agent-signals.js'

const claude = (body) => normalizeSignal('claude', body)

test('a prompt, or a tool finishing after approval, means working', () => {
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
    assert.deepEqual(claude({ hook_event_name: event }), { provider: 'claude', state: 'working', detail: '' }, event)
  }
})

test('a permission request needs the user and names the tool and its target', () => {
  const bash = claude({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm   test\n--watch' } })
  assert.equal(bash.state, 'needs-you')
  assert.equal(bash.detail, 'Permission: Bash: npm test --watch')
  const edit = claude({ hook_event_name: 'PermissionRequest', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } })
  assert.equal(edit.detail, 'Permission: Edit: src/a.ts')
  assert.equal(claude({ hook_event_name: 'PermissionRequest' }).detail, 'Permission: a tool')
})

test('notifications that block on the user need the user; idle ones are finished; the rest say nothing', () => {
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']) {
    const signal = claude({ hook_event_name: 'Notification', notification_type: type, message: 'Claude needs your attention' })
    assert.equal(signal.state, 'needs-you', type)
    assert.equal(signal.detail, 'Claude needs your attention')
  }
  for (const type of ['idle_prompt', 'agent_completed']) {
    assert.equal(claude({ hook_event_name: 'Notification', notification_type: type }).state, 'finished', type)
  }
  for (const type of ['auth_success', 'quota_auto_resume_fired', 'something_new']) {
    assert.equal(claude({ hook_event_name: 'Notification', notification_type: type }), undefined, type)
  }
})

test('stop, failure and session events map to finished, failed, idle and ended', () => {
  assert.equal(claude({ hook_event_name: 'Stop' }).state, 'finished')
  assert.equal(claude({ hook_event_name: 'SessionStart' }).state, 'idle')
  assert.equal(claude({ hook_event_name: 'SessionEnd' }).state, 'ended')
  const failed = claude({ hook_event_name: 'StopFailure', error_type: 'rate_limit', error_message: 'slow down' })
  assert.equal(failed.state, 'failed')
  assert.equal(failed.detail, 'rate_limit: slow down')
})

test('events that say nothing about state are ignored', () => {
  for (const event of ['PreToolUse', 'SubagentStop', 'PreCompact', 'FileChanged', 'SomethingNew', undefined]) {
    assert.equal(claude({ hook_event_name: event }), undefined, String(event))
  }
})

test('a provider-neutral body with a valid state needs no adapter', () => {
  assert.deepEqual(normalizeSignal('codex', { state: 'needs-you', detail: 'approve?' }), { provider: 'codex', state: 'needs-you', detail: 'approve?' })
  assert.equal(normalizeSignal('codex', { state: 'bogus' }), undefined)
  assert.equal(normalizeSignal('codex', { hook_event_name: 'Stop' }), undefined, 'no adapter registered for codex')
})

test('malformed bodies are rejected without throwing', () => {
  for (const body of [null, undefined, 42, 'Stop', [], [{ state: 'working' }]]) {
    assert.equal(normalizeSignal('claude', body), undefined, JSON.stringify(body))
  }
})

test('detail is flattened and capped so a signal never carries a transcript', () => {
  const signal = claude({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `a\n\nb ${'x'.repeat(500)}` })
  assert.ok(signal.detail.length <= 160)
  assert.ok(!signal.detail.includes('\n'))
  assert.ok(signal.detail.endsWith('…'))
})

test('every state the adapter can emit is a known state', () => {
  const emitted = new Set()
  for (const event of CLAUDE_HOOK_EVENTS) {
    for (const extra of [{}, { notification_type: 'permission_prompt' }, { notification_type: 'idle_prompt' }]) {
      const signal = claudeAdapter({ hook_event_name: event, ...extra })
      if (signal !== undefined) emitted.add(signal.state)
    }
  }
  for (const state of emitted) assert.ok(AGENT_STATES.includes(state), state)
  assert.equal(emitted.size, AGENT_STATES.length, 'subscribed events cover every state')
})

test('the Claude settings file subscribes HTTP hooks and keeps the secret out of the file', () => {
  const settings = buildClaudeSettings('http://127.0.0.1:5555/signal/claude')
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...CLAUDE_HOOK_EVENTS].sort())
  for (const groups of Object.values(settings.hooks)) {
    const [hook] = groups[0].hooks
    assert.equal(hook.type, 'http')
    assert.equal(hook.url, 'http://127.0.0.1:5555/signal/claude')
    assert.ok(hook.timeout <= 10, 'a dead host must not hold Claude up')
    assert.deepEqual(hook.allowedEnvVars, [TOKEN_ENV])
    assert.equal(hook.headers[TOKEN_HEADER], `$${TOKEN_ENV}`)
  }
  assert.ok(!JSON.stringify(settings).match(/[0-9a-f]{32}/), 'no secret value in the file')
})

test('every subscribed event is understood by the adapter', () => {
  for (const event of CLAUDE_HOOK_EVENTS) {
    const hit = [{}, { notification_type: 'permission_prompt' }].some((extra) => claudeAdapter({ hook_event_name: event, ...extra }) !== undefined)
    assert.ok(hit, `${event} is subscribed but maps to nothing`)
  }
})

test('the conversation id rides along on the signal when it is safe', () => {
  const id = '3f4a3c42-a672-45ff-a7f5-ac6abdc48a8e'
  assert.equal(claude({ hook_event_name: 'UserPromptSubmit', session_id: id }).session, id)
  assert.equal(claude({ hook_event_name: 'Stop', session_id: id }).session, id)
  assert.equal(normalizeSignal('codex', { state: 'working', session: id }).session, id)
  assert.ok(!('session' in claude({ hook_event_name: 'Stop' })), 'no id, no key')
})

test('an unsafe conversation id is dropped, because it ends up in a shell command', () => {
  for (const bad of ['x; rm -rf ~', '$(whoami)', 'a b c d e f g h', '`id`', '--help', 'short', '"quoted-id-1234"', 'a'.repeat(65), 42, null, {}]) {
    const signal = claude({ hook_event_name: 'Stop', session_id: bad })
    assert.equal(signal.state, 'finished', 'the state still comes through')
    assert.ok(!('session' in signal), `rejected ${JSON.stringify(bad)}`)
  }
  assert.ok(SESSION_ID.test('3f4a3c42-a672-45ff-a7f5-ac6abdc48a8e'))
})

test('the Claude settings file adds the status-line wrapper only when asked, with a forward-slash path', () => {
  assert.equal(buildClaudeSettings('http://127.0.0.1:1/signal/claude').statusLine, undefined)
  const settings = buildClaudeSettings('http://127.0.0.1:1/signal/claude', {
    statusLine: { script: String.raw`C:\plug ins\lib\statusline.js`, url: 'http://127.0.0.1:1/signal/usage', refreshInterval: 4 },
  })
  assert.deepEqual(settings.statusLine, {
    type: 'command',
    command: 'node "C:/plug ins/lib/statusline.js" http://127.0.0.1:1/signal/usage',
    refreshInterval: 4,
  })
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...CLAUDE_HOOK_EVENTS].sort())
})
