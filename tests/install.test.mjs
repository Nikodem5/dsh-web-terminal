// scripts/install.mjs against a throwaway release-archive layout and a throwaway DSH home: scoped package folders,
// the three ways to name a package, replacing a v0.1.0 (unscoped) install, and --remove. No real profile is touched.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const INSTALLER = join(fileURLToPath(import.meta.url), '..', '..', 'scripts', 'install.mjs')
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-install-'))
after(() => rmSync(sandbox, { recursive: true, force: true }))

const REPO_URL = 'https://github.com/Nikodem5/dsh-web-terminal.git'
const TERMINAL = '@nikodem5/dsh-web-terminal'
const EDITOR = '@nikodem5/dsh-code-editor'

let counter = 0
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))

/** A release-archive layout (install.mjs beside packages/) with both plugins "built", plus an empty DSH home with one profile. */
function setup({ bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], dependencies = {} } = {}) {
  const base = join(sandbox, `case-${++counter}`)
  const archive = join(base, 'archive')
  const home = join(base, 'home')
  mkdirSync(archive, { recursive: true })
  cpSync(INSTALLER, join(archive, 'install.mjs'))
  for (const [dirName, name] of [['terminal', TERMINAL], ['code-editor', EDITOR]]) {
    const dir = join(archive, 'packages', dirName)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.2.0', repository: { type: 'git', url: REPO_URL }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: []\n')
    writeFileSync(join(dir, 'lib', 'client.js'), '// built\n')
    writeFileSync(join(dir, 'lib', 'index.js'), '// host\n')
  }
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2))
  return { archive, home, profileDir, manifest: () => json(join(profileDir, 'package.json')) }
}

/** An unscoped copy the way v0.1.0 left it. */
function legacyInstall(profileDir, name, repository = { type: 'git', url: REPO_URL }) {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.0', repository }))
  writeFileSync(join(dir, 'lib', 'index.js'), '// old\n')
  return dir
}

const OLD_TERMINAL = 'dsh-web-terminal'
const OWN_SPEC = `file:./node_modules/${OLD_TERMINAL}`

/** A second, healthy profile next to `desktop` in the same DSH home. */
function addProfile(ctx, name) {
  const dir = join(ctx.home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2))
  return dir
}

/** Every file and folder below `dir` with its content, to compare a tree before and after a run. */
function snapshot(dir, base = dir, into = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const key = relative(base, path).split(sep).join('/')
    if (entry.isDirectory()) {
      into[key] = '<dir>'
      snapshot(path, base, into)
    } else into[key] = readFileSync(path, 'utf8')
  }
  return into
}

function run(ctx, ...argv) {
  const result = spawnSync(process.execPath, [join(ctx.archive, 'install.mjs'), ...argv], { env: { ...process.env, DSH_HOME: ctx.home }, encoding: 'utf8', windowsHide: true })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

test('installs a scoped package into node_modules/@scope/<name> and records the scoped name', () => {
  const ctx = setup()
  const r = run(ctx, 'desktop')
  assert.equal(r.status, 0, r.err)
  for (const [name, scopedDir] of [[TERMINAL, 'dsh-web-terminal'], [EDITOR, 'dsh-code-editor']]) {
    const target = join(ctx.profileDir, 'node_modules', '@nikodem5', scopedDir)
    assert.equal(json(join(target, 'package.json')).name, name)
    assert.ok(existsSync(join(target, 'cordis.patch.yml')))
    assert.ok(existsSync(join(target, 'lib', 'client.js')))
    assert.equal(ctx.manifest().dependencies[name], `file:./node_modules/${name}`)
    assert.ok(ctx.manifest().dsh.profile.bundles.includes(name))
  }
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', 'dsh-web-terminal')), false)
  // Re-running is idempotent: one bundle entry per plugin.
  assert.equal(run(ctx, 'desktop').status, 0)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles.filter((b) => b === TERMINAL), [TERMINAL])
})

test('--package accepts the scoped name, the unscoped name and the folder name, and rejects anything else', () => {
  for (const alias of [TERMINAL, 'dsh-web-terminal', 'terminal']) {
    const ctx = setup()
    const r = run(ctx, '--package', alias, 'desktop')
    assert.equal(r.status, 0, `${alias}: ${r.err}`)
    assert.ok(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5', 'dsh-web-terminal', 'package.json')), alias)
    assert.equal(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5', 'dsh-code-editor')), false, alias)
  }
  const ctx = setup()
  const r = run(ctx, '--package', 'nope', 'desktop')
  assert.equal(r.status, 1)
  assert.match(r.err, /no installable package matches "nope"/)
  assert.ok(r.err.includes(TERMINAL) && r.err.includes(EDITOR), r.err)
})

test('upgrading from 0.1.0 replaces the unscoped copy in place: one copy on disk, one manifest entry, same load order', () => {
  const ctx = setup({
    bundles: ['@deepseek-ai/dsh-base', 'dsh-web-terminal', '@deepseek-ai/dsh-experimental-auto-review', 'dsh-code-editor', '@deepseek-ai/dsh-last'],
    dependencies: { 'dsh-web-terminal': 'file:./node_modules/dsh-web-terminal', 'dsh-code-editor': 'file:./node_modules/dsh-code-editor', other: '^1.0.0' },
  })
  const oldTerminal = legacyInstall(ctx.profileDir, 'dsh-web-terminal')
  const oldEditor = legacyInstall(ctx.profileDir, 'dsh-code-editor')
  const r = run(ctx, 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.equal(existsSync(oldTerminal), false)
  assert.equal(existsSync(oldEditor), false)
  const manifest = ctx.manifest()
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', TERMINAL, '@deepseek-ai/dsh-experimental-auto-review', EDITOR, '@deepseek-ai/dsh-last'])
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [EDITOR, TERMINAL, 'other'])
  assert.match(r.out, /replace the older unscoped copy/)
})

test('installing one plugin by name replaces only that plugin\'s old copy', () => {
  const ctx = setup({ bundles: ['dsh-web-terminal', 'dsh-code-editor'], dependencies: { 'dsh-web-terminal': 'file:./node_modules/dsh-web-terminal', 'dsh-code-editor': 'file:./node_modules/dsh-code-editor' } })
  const oldTerminal = legacyInstall(ctx.profileDir, 'dsh-web-terminal')
  const oldEditor = legacyInstall(ctx.profileDir, 'dsh-code-editor')
  assert.equal(run(ctx, '--package', TERMINAL, 'desktop').status, 0)
  assert.equal(existsSync(oldTerminal), false)
  assert.equal(existsSync(oldEditor), true)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [TERMINAL, 'dsh-code-editor'])
})

test('an unscoped package from another project is left alone and reported', () => {
  const ctx = setup({ bundles: ['dsh-web-terminal'], dependencies: { 'dsh-web-terminal': '^3.0.0' } })
  const stranger = legacyInstall(ctx.profileDir, 'dsh-web-terminal', { type: 'git', url: 'https://github.com/someone-else/dsh-web-terminal.git' })
  const r = run(ctx, '--package', 'terminal', 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.equal(existsSync(stranger), true)
  assert.match(r.err, /does not come from this project/)
  assert.equal(ctx.manifest().dependencies['dsh-web-terminal'], '^3.0.0')
  assert.ok(ctx.manifest().dsh.profile.bundles.includes('dsh-web-terminal'))
  assert.ok(ctx.manifest().dsh.profile.bundles.includes(TERMINAL))
})

test('a manifest entry whose old folder is already gone is dropped on install', () => {
  const ctx = setup({ bundles: ['dsh-web-terminal'], dependencies: { 'dsh-web-terminal': 'file:./node_modules/dsh-web-terminal' } })
  assert.equal(run(ctx, '--package', 'terminal', 'desktop').status, 0)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [TERMINAL])
  assert.deepEqual(Object.keys(ctx.manifest().dependencies), [TERMINAL])
})

test('--remove deletes the scoped copy, any old unscoped copy and their manifest entries, and the emptied scope folder', () => {
  const ctx = setup()
  assert.equal(run(ctx, 'desktop').status, 0)
  const oldEditor = legacyInstall(ctx.profileDir, 'dsh-code-editor')
  writeFileSync(join(ctx.profileDir, 'package.json'), JSON.stringify({ ...ctx.manifest(), dependencies: { ...ctx.manifest().dependencies, 'dsh-code-editor': 'file:./node_modules/dsh-code-editor' } }))

  assert.equal(run(ctx, '--remove', '--package', 'terminal', 'desktop').status, 0)
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5', 'dsh-web-terminal')), false)
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5', 'dsh-code-editor')), true, 'the sibling plugin and the scope folder stay')
  assert.equal(existsSync(oldEditor), true)

  assert.equal(run(ctx, '--remove', 'desktop').status, 0)
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5')), false, 'the emptied scope folder goes too')
  assert.equal(existsSync(oldEditor), false)
  assert.deepEqual(ctx.manifest().dependencies, {})
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
})

test('--dry-run reports the replacement and writes nothing', () => {
  const ctx = setup({ bundles: ['dsh-web-terminal'], dependencies: { 'dsh-web-terminal': 'file:./node_modules/dsh-web-terminal' } })
  const old = legacyInstall(ctx.profileDir, 'dsh-web-terminal')
  const before = readFileSync(join(ctx.profileDir, 'package.json'), 'utf8')
  const r = run(ctx, '--dry-run', '--package', TERMINAL, 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /\[dry-run\] install @nikodem5\/dsh-web-terminal/)
  assert.match(r.out, /\[dry-run\] replace the older unscoped copy/)
  assert.equal(existsSync(old), true)
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5')), false)
  assert.equal(readFileSync(join(ctx.profileDir, 'package.json'), 'utf8'), before)
})

test('a legacy copy with no repository but the installer\'s own file: spec is ours and gets replaced', () => {
  const ctx = setup({ bundles: [OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: OWN_SPEC } })
  const old = legacyInstall(ctx.profileDir, OLD_TERMINAL, null)
  const r = run(ctx, '--package', 'terminal', 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.equal(existsSync(old), false)
  assert.doesNotMatch(r.err, /does not come from this project/)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [TERMINAL])
  assert.deepEqual(Object.keys(ctx.manifest().dependencies), [TERMINAL])
})

test('a legacy copy with no repository but an install-source.json is ours and gets replaced', () => {
  const ctx = setup({ bundles: [OLD_TERMINAL] })
  const old = legacyInstall(ctx.profileDir, OLD_TERMINAL, null)
  writeFileSync(join(old, 'install-source.json'), '{}\n')
  const r = run(ctx, '--package', 'terminal', 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.equal(existsSync(old), false)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [TERMINAL])
})

test('the repository marker accepts the common URL forms of this project and nothing that merely contains it', () => {
  const cases = [
    [{ type: 'git', url: 'git+https://github.com/Nikodem5/dsh-web-terminal.git' }, true],
    [{ type: 'git', url: 'git@github.com:nikodem5/dsh-web-terminal.git' }, true],
    ['https://github.com/nikodem5/dsh-web-terminal', true],
    ['https://notgithub.com/nikodem5/dsh-web-terminal', false],
    ['https://github.com/nikodem5/dsh-web-terminal-fork', false],
    ['https://github.com/someone-else/dsh-web-terminal.git', false],
  ]
  for (const [repository, ours] of cases) {
    const ctx = setup({ bundles: [OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: '^0.1.0' } })
    const old = legacyInstall(ctx.profileDir, OLD_TERMINAL, repository)
    const r = run(ctx, '--package', 'terminal', 'desktop')
    assert.equal(r.status, 0, r.err)
    assert.equal(existsSync(old), !ours, JSON.stringify(repository))
  }
})

test('a foreign copy (no repository, semver spec, no install-source.json) is untouched by install and by --remove', () => {
  const ctx = setup({ bundles: [OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: '^3.0.0' } })
  const stranger = legacyInstall(ctx.profileDir, OLD_TERMINAL, null)
  const before = snapshot(stranger)

  const installed = run(ctx, '--package', 'terminal', 'desktop')
  assert.equal(installed.status, 0, installed.err)
  assert.match(installed.err, /does not come from this project; leaving it alone/)
  assert.deepEqual(snapshot(stranger), before)
  assert.equal(ctx.manifest().dependencies[OLD_TERMINAL], '^3.0.0')
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [OLD_TERMINAL, TERMINAL])
  assert.ok(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5', 'dsh-web-terminal', 'package.json')), 'the scoped plugin is installed next to it')

  const removed = run(ctx, '--remove', '--package', 'terminal', 'desktop')
  assert.equal(removed.status, 0, removed.err)
  assert.match(removed.err, /not removed: .* does not come from this project/)
  assert.doesNotMatch(removed.err, /leaving it alone/)
  assert.deepEqual(snapshot(stranger), before)
  assert.equal(ctx.manifest().dependencies[OLD_TERMINAL], '^3.0.0')
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [OLD_TERMINAL])
  assert.equal(existsSync(join(ctx.profileDir, 'node_modules', '@nikodem5')), false)
})

test('a manifest-only entry with a foreign spec survives and is reported', () => {
  for (const spec of ['^3.0.0', 'github:someone-else/dsh-web-terminal']) {
    const ctx = setup({ bundles: [OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: spec } })
    const r = run(ctx, '--package', 'terminal', 'desktop')
    assert.equal(r.status, 0, r.err)
    assert.match(r.err, /does not come from this project/, spec)
    assert.equal(ctx.manifest().dependencies[OLD_TERMINAL], spec)
    assert.deepEqual(ctx.manifest().dsh.profile.bundles, [OLD_TERMINAL, TERMINAL])
    assert.equal(ctx.manifest().dependencies[TERMINAL], `file:./node_modules/${TERMINAL}`)

    const removed = run(ctx, '--remove', '--package', 'terminal', 'desktop')
    assert.equal(removed.status, 0, removed.err)
    assert.match(removed.err, /not removed/, spec)
    assert.equal(ctx.manifest().dependencies[OLD_TERMINAL], spec)
    assert.deepEqual(ctx.manifest().dsh.profile.bundles, [OLD_TERMINAL])
  }
})

test('a bundles entry with no dependency and no folder cannot be proven ours: left alone and reported', () => {
  const ctx = setup({ bundles: [OLD_TERMINAL] })
  const r = run(ctx, '--package', 'terminal', 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.match(r.err, /only in dsh\.profile\.bundles/)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [OLD_TERMINAL, TERMINAL])
  assert.equal(OLD_TERMINAL in ctx.manifest().dependencies, false)
})

test('a manifest-only entry with the installer\'s own file: spec is dropped on --remove too', () => {
  const ctx = setup({ bundles: [OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: OWN_SPEC } })
  assert.equal(run(ctx, '--remove', '--package', 'terminal', 'desktop').status, 0)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, [])
  assert.deepEqual(ctx.manifest().dependencies, {})
})

test('a profile whose package.json is missing or invalid is skipped untouched, the rest still run, and the exit code is non-zero', () => {
  const broken = [
    ['missing', null, /skip desktop: package\.json is missing/],
    ['invalid JSON', '{ "dependencies": ', /skip desktop: package\.json is not valid JSON/],
    ['not an object', '[]', /skip desktop: package\.json is not a JSON object/],
  ]
  for (const argv of [[], ['--remove']]) {
    for (const [label, content, message] of broken) {
      const ctx = setup({ bundles: [OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: OWN_SPEC } })
      legacyInstall(ctx.profileDir, OLD_TERMINAL)
      const web = addProfile(ctx, 'web')
      if (content === null) rmSync(join(ctx.profileDir, 'package.json'))
      else writeFileSync(join(ctx.profileDir, 'package.json'), content)
      const before = snapshot(ctx.profileDir)
      const r = run(ctx, ...argv, 'desktop', 'web')
      const where = `${label} ${argv.join(' ')}`
      assert.equal(r.status, 1, where)
      assert.match(r.err, message, where)
      assert.deepEqual(snapshot(ctx.profileDir), before, where)
      if (argv.length === 0) {
        assert.ok(existsSync(join(web, 'node_modules', '@nikodem5', 'dsh-web-terminal', 'package.json')), `${where}: the healthy profile is installed`)
        assert.equal(json(join(web, 'package.json')).dependencies[TERMINAL], `file:./node_modules/${TERMINAL}`, where)
      }
    }
  }
})

test('duplicate legacy bundle entries collapse into one scoped entry at the first position, other order kept', () => {
  const ctx = setup({ bundles: ['@deepseek-ai/dsh-base', OLD_TERMINAL, 'x', OLD_TERMINAL, 'y'], dependencies: { [OLD_TERMINAL]: OWN_SPEC } })
  legacyInstall(ctx.profileDir, OLD_TERMINAL)
  assert.equal(run(ctx, '--package', 'terminal', 'desktop').status, 0)
  assert.deepEqual(ctx.manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base', TERMINAL, 'x', 'y'])

  const both = setup({ bundles: ['a', OLD_TERMINAL, 'b', TERMINAL, 'c', OLD_TERMINAL], dependencies: { [OLD_TERMINAL]: OWN_SPEC } })
  legacyInstall(both.profileDir, OLD_TERMINAL)
  assert.equal(run(both, '--package', 'terminal', 'desktop').status, 0)
  assert.deepEqual(both.manifest().dsh.profile.bundles, ['a', TERMINAL, 'b', 'c'])
})

test('--remove --dry-run reports the removal and writes nothing', () => {
  const ctx = setup()
  assert.equal(run(ctx, 'desktop').status, 0)
  const old = legacyInstall(ctx.profileDir, 'dsh-code-editor')
  writeFileSync(join(ctx.profileDir, 'package.json'), JSON.stringify({ ...ctx.manifest(), dependencies: { ...ctx.manifest().dependencies, 'dsh-code-editor': 'file:./node_modules/dsh-code-editor' } }))
  const before = snapshot(ctx.home)
  const r = run(ctx, '--remove', '--dry-run', 'desktop')
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /\[dry-run\] remove .*dsh-web-terminal/)
  assert.match(r.out, /\[dry-run\] remove the older unscoped copy/)
  assert.doesNotMatch(r.out, /^removed /m)
  assert.equal(existsSync(old), true)
  assert.deepEqual(snapshot(ctx.home), before)
})
