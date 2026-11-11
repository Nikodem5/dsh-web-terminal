// The help panel's data and diagnostics report (src/client/help-data.ts), and the checks that keep the
// legends in step with the stylesheet they describe.
//
//   node --test tests/help.test.mjs

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let h

before(async () => {
  const result = await build({ entryPoints: [join(root, 'src', 'client', 'help-data.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  h = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
})

const NOW = Date.UTC(2026, 0, 5, 12, 0, 0)
const base = () => ({
  version: '0.1.0',
  platform: 'win32',
  node: { available: true, path: 'C:\\node\\node.exe' },
  agents: [{ command: 'claude', info: { available: true, path: 'C:\\bin\\claude.exe' } }],
  ssh: { available: true, path: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', hosts: [{}, {}, {}] },
  statusLine: { enabled: true, reason: null },
  shellIntegration: true,
  focused: { name: 'api', markersSeen: true },
  conns: { live: 3, connecting: 1, offline: 0, exited: 0 },
  sampledAt: NOW - 125_000,
  now: NOW,
})

test('buildDiagnostics: one plain line per fact', () => {
  const lines = h.buildDiagnostics(base()).split('\n')
  assert.equal(lines[0], 'DSH Web Terminal diagnostics')
  assert.ok(lines.includes('Plugin version: 0.1.0'))
  assert.ok(lines.includes('node: found (C:\\node\\node.exe)'))
  assert.ok(lines.includes('claude: found (C:\\bin\\claude.exe)'))
  assert.ok(lines.includes('ssh: found (C:\\Windows\\System32\\OpenSSH\\ssh.exe)'))
  assert.ok(lines.includes('ssh config hosts: 3'))
  assert.ok(lines.includes('Status-line wrapper: enabled'))
  assert.ok(lines.includes('Shell integration: on (setting); markers seen in "api"'))
  assert.ok(lines.includes('Terminals: 3 live, 1 connecting, 0 offline'))
  assert.ok(lines.some((l) => l.startsWith('Stats sample: 2m ago (')))
  assert.equal(lines.length, 11)
})

test('buildDiagnostics: problems are spelled out', () => {
  const d = base()
  d.node = { available: false, path: null }
  d.agents = [{ command: 'claude', info: { available: false, path: null } }]
  d.statusLine = { enabled: false, reason: 'node not on PATH' }
  d.shellIntegration = false
  d.focused = { name: 'x', markersSeen: false }
  d.conns = { live: 0, connecting: 0, offline: 2, exited: 1 }
  d.sampledAt = null
  const text = h.buildDiagnostics(d)
  assert.match(text, /^node: not found$/m)
  assert.match(text, /^claude: not found$/m)
  assert.match(text, /^Status-line wrapper: off: node not on PATH$/m)
  assert.match(text, /^Shell integration: off \(setting\); no markers yet in "x"$/m)
  assert.match(text, /^Terminals: 0 live, 0 connecting, 2 offline, 1 exited$/m)
  assert.match(text, /^Stats sample: no sample yet$/m)
  const rows = h.diagnosticRows(d)
  assert.deepEqual(rows.filter((r) => r.bad).map((r) => r.label), ['node', 'claude', 'Status-line wrapper', 'Terminals'])
})

test('buildDiagnostics: a missing agent is neutral while another is found, red when none is', () => {
  const agents = (claude, agy) => [{ command: 'claude', info: claude }, { command: 'agy', info: agy }]
  const found = { available: true, path: 'C:/bin/x.exe' }
  const gone = { available: false, path: null }
  const bad = (d) => h.diagnosticRows(d).filter((r) => r.bad).map((r) => r.label)
  const one = { ...base(), agents: agents(found, gone) }
  assert.match(h.buildDiagnostics(one), /^agy: not found$/m, 'still listed')
  assert.deepEqual(bad(one), [])
  assert.deepEqual(bad({ ...base(), agents: agents(gone, found) }), [])
  assert.deepEqual(bad({ ...base(), agents: agents(gone, gone) }), ['claude', 'agy'])
  assert.deepEqual(bad({ ...base(), agents: agents(found, found) }), [])
})

test('warnsMissingAgents: only when no provider was found', () => {
  assert.equal(h.warnsMissingAgents([{ available: true }, { available: false }]), false)
  assert.equal(h.warnsMissingAgents([{ available: false }, { available: false }]), true)
  assert.equal(h.warnsMissingAgents([{ available: false }, undefined]), true, 'the other has not answered yet')
  assert.equal(h.warnsMissingAgents([]), true)
})

test('buildDiagnostics: an old host or no answer yet shows "unknown", never a false "not found"', () => {
  const d = { ...base(), version: undefined, node: undefined, agents: [{ command: 'claude', info: undefined }], statusLine: undefined, focused: null }
  const text = h.buildDiagnostics(d)
  assert.match(text, /^Plugin version: unknown$/m)
  assert.match(text, /^node: unknown/m)
  assert.match(text, /^Status-line wrapper: unknown/m)
  assert.match(text, /no terminal focused/)
  assert.ok(h.diagnosticRows(d).every((r) => !r.bad))
})

test('buildDiagnostics: ssh missing is reported but is not a problem; an old host says unknown', () => {
  const missing = { ...base(), ssh: { available: false, path: null, hosts: [] } }
  assert.match(h.buildDiagnostics(missing), /^ssh: not found$/m)
  assert.match(h.buildDiagnostics(missing), /^ssh config hosts: 0$/m)
  assert.ok(!h.diagnosticRows(missing).some((r) => r.bad && r.label.startsWith('ssh')))
  const old = { ...base(), ssh: undefined }
  assert.match(h.buildDiagnostics(old), /^ssh: unknown/m)
  assert.match(h.buildDiagnostics(old), /^ssh config hosts: unknown/m)
})

test('the report holds no secrets: only the facts above, whatever the inputs carry', () => {
  const d = { ...base(), token: 'DSH_WT_TOKEN=abc123', env: { DSH_WT_TOKEN: 'abc123' } }
  assert.doesNotMatch(h.buildDiagnostics(d), /TOKEN|abc123/)
})

test('countConns: live, connecting and offline (lost or failed); exited apart', () => {
  assert.deepEqual(h.countConns(['live', 'live', 'connecting', 'lost', 'failed', 'exited']), { live: 2, connecting: 1, offline: 2, exited: 1 })
  assert.deepEqual(h.countConns([]), { live: 0, connecting: 0, offline: 0, exited: 0 })
})

const css = (file) => readFileSync(join(root, 'src', 'client', file), 'utf8')

test('the status legend lists every dot colour the stylesheet defines, and nothing else', () => {
  const styled = new Set([...css('styles.ts').matchAll(/\.wt-dot\[data-a="([\w-]+)"\]/g)].map((m) => m[1]))
  assert.deepEqual([...styled].sort(), [...h.ACTIVITY_ORDER].sort())
  for (const a of h.ACTIVITY_ORDER) assert.ok(h.ACTIVITY_TITLE[a].length > 0)
})

test('the badge and gutter legends match the stylesheets', () => {
  const gutter = new Set([...css('blocks.css.ts').matchAll(/\.xterm-decoration\.wt-gutter\[data-state="(\w+)"\]/g)].map((m) => m[1]))
  assert.deepEqual([...gutter].sort(), h.GUTTER_LEGEND.map((g) => g.state).sort())
  const swatch = new Set([...css('blocks.css.ts').matchAll(/\.wt-gutter-swatch\[data-state="(\w+)"\]/g)].map((m) => m[1]))
  assert.deepEqual([...swatch].sort(), [...gutter].sort(), 'the legend swatch is drawn by the same rules')
  assert.deepEqual(h.ATTENTION_LEGEND.map((a) => a.level).sort(), ['quiet', 'urgent'])
})

test('the command-header and alert legends describe what the code has', () => {
  const bar = css('block-bar.ts')
  const glyphs = [...bar.matchAll(/glyph: '([^']+)'/g)].map((m) => m[1])
  assert.equal(glyphs.length, 5)
  const described = h.BLOCK_ACTIONS.map((a) => a.how).join('\n')
  for (const g of glyphs) assert.ok(described.includes(g), `the help describes the ${g} button`)
  const notify = css('block-notify.ts')
  for (const a of h.COMMAND_ALERT_LEGEND) assert.ok(notify.includes(`label: '${a.badge}'`), `${a.badge} is a label block-notify.ts raises`)
  assert.equal(h.COMMAND_ALERT_LEGEND.length, 2)
})

test('the agent-mark help describes the marker, its lifetime and its requirement', () => {
  const text = h.AGENT_MARK_HELP.map((m) => `${m.how} ${m.what}`).join(' ')
  assert.equal(h.AGENT_MARK_HELP.length, 3)
  assert.match(text, /code editor/)
  assert.match(text, /terminal is open/)
})

test('help text that lists the agents names every provider the UI offers, not just Claude', async () => {
  const built = await build({ entryPoints: [join(root, 'src', 'client', 'providers.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  const { providers } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  assert.ok(providers.length >= 2)
  const send = h.MOUSE_ACTIONS.find((m) => m.how === 'Right-click a selection')
  const ssh = h.SSH_HELP.find((m) => m.how === 'Not available over ssh yet')
  for (const p of providers) {
    assert.ok(send.what.includes(p.label), `the send-menu row names ${p.label}`)
    assert.ok(ssh.what.includes(p.label), `the ssh row names ${p.label}`)
  }
  assert.doesNotMatch(send.what, /new Claude terminal/)
})

test('the awareness help matches what the code does', () => {
  const text = h.AWARENESS_HELP.map((m) => m.how + ' ' + m.what).join('\n')
  assert.ok(css('attention.ts').includes("HUNG_LABEL = 'possibly hung'"))
  assert.ok(text.includes('possibly hung') && text.includes('5 minutes'))
  assert.match(css('state.ts'), /hungMinutes: 5,/)
  const core = css('pattern-alerts-core.ts')
  assert.match(core, /TEXT_MAX = 200/)
  assert.match(core, /LINE_MAX = 2000/)
  assert.match(core, /PATTERNS_MAX = 20/)
  assert.match(core, /COOLDOWN_DEFAULT = 30/)
  for (const name of ['Asks to proceed', 'Test failure']) assert.ok(core.includes("name: '" + name + "'") && text.includes(name))
  assert.match(css('git-header.ts'), /BRANCH_SHOWN/)
  assert.match(readFileSync(join(root, 'lib', 'index.js'), 'utf8'), /DSH_WT_GIT_INTERVAL_MS', 30_000/)
  assert.ok(text.includes('every 30 s'))
})

test('the agent-mark help says only Claude reports edits', () => {
  const need = h.AGENT_MARK_HELP.find((m) => m.how === 'Needs Claude hooks')
  assert.match(need.what, /Antigravity terminals do not/)
})

test('the agent help covers each provider, the resume caveat and what a hand-typed agent gets', async () => {
  const built = await build({ entryPoints: [join(root, 'src', 'client', 'providers.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
  const { providers } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const text = h.AGENT_HELP.map((m) => `${m.how} ${m.what}`).join('\n')
  for (const p of providers) {
    assert.ok(text.includes(p.label), `${p.label} is described`)
    assert.ok(text.includes(`\`${p.command}\``), `${p.command} is named as the command`)
  }
  assert.match(text, /agy -c/)
  assert.match(text, /two Antigravity terminals in one folder/)
  assert.match(text, /fake a status/)
  assert.match(text, /Started by hand/)
})
