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
  claude: { available: true, path: 'C:\\bin\\claude.exe' },
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
  assert.ok(lines.includes('Status-line wrapper: enabled'))
  assert.ok(lines.includes('Shell integration: on (setting); markers seen in "api"'))
  assert.ok(lines.includes('Terminals: 3 live, 1 connecting, 0 offline'))
  assert.ok(lines.some((l) => l.startsWith('Stats sample: 2m ago (')))
  assert.equal(lines.length, 9)
})

test('buildDiagnostics: problems are spelled out', () => {
  const d = base()
  d.node = { available: false, path: null }
  d.claude = { available: false, path: null }
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

test('buildDiagnostics: an old host or no answer yet shows "unknown", never a false "not found"', () => {
  const d = { ...base(), version: undefined, node: undefined, claude: undefined, statusLine: undefined, focused: null }
  const text = h.buildDiagnostics(d)
  assert.match(text, /^Plugin version: unknown$/m)
  assert.match(text, /^node: unknown/m)
  assert.match(text, /^Status-line wrapper: unknown/m)
  assert.match(text, /no terminal focused/)
  assert.ok(h.diagnosticRows(d).every((r) => !r.bad))
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
