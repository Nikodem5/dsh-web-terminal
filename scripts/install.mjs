// Installs the plugins of this monorepo into one or more dsh profiles as real package copies.
//
// Why a copy and not `dsh plugin add <path>`: that records a `link:` dependency,
// which mounts the package through a junction in the profile's node_modules
// pointing at this workspace. The client-modules registry resolves each loader
// row's manifest relative to the profile tree, and a package whose real path
// lives outside that tree is skipped — the host half still mounts, but the
// browser half never reaches the client bundle graph. Copying `lib/` plus the
// two manifests into the profile keeps the package physically inside the tree.
//
// Usage: node scripts/install.mjs (from a release archive: node install.mjs) [--remove] [--dry-run] [--package <name>|all] [profile ...]
//        (default: every built plugin package, profiles desktop and web)
//        <name> is the npm name (@nikodem5/dsh-web-terminal), the unscoped name (dsh-web-terminal) or the folder under packages/ (terminal).
//        --dry-run prints what would be copied or removed without writing anything.
//
// Scoped names: a package named @scope/<pkg> is installed at node_modules/@scope/<pkg>. Up to 0.1.0 the plugins were
// named without a scope (dsh-web-terminal, dsh-code-editor), so installing or removing one also replaces a copy of the
// old unscoped name in the same profile; otherwise both would be loaded. Only a copy that comes from this project is
// touched (see legacyCopy): an unrelated package that merely shares the old name is left alone and reported.
// A profile whose package.json is missing or invalid is skipped untouched and the exit code is non-zero.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// In the repo this file is scripts/install.mjs (packages/ is one level up); in a release archive it sits
// next to packages/ (see scripts/pack-release.mjs), so look beside it first.
const here = dirname(fileURLToPath(import.meta.url))
const root = existsSync(join(here, 'packages')) ? here : join(here, '..')
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')

const args = process.argv.slice(2)
const remove = args.includes('--remove')
const dryRun = args.includes('--dry-run')
const profiles = []
let only = 'all'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--package') only = args[++i] ?? ''
  else if (!args[i].startsWith('--')) profiles.push(args[i])
}
if (profiles.length === 0) profiles.push('desktop', 'web')

/** `@scope/name` -> `name`; an unscoped name is returned as it is. */
const unscoped = (name) => name.replace(/^@[^/]+\//, '')

/** Repository these plugins are published from: one marker of a copy that belongs to this project. */
const OWN_REPOSITORY = /(?:^|[/@.])github\.com[/:]nikodem5\/dsh-web-terminal(?:\.git)?(?:$|[/#?])/i

/** Installable plugins: packages/* whose manifest carries a `dsh` block (placeholders have none). */
const plugins = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
  .map((entry) => {
    const dir = join(root, 'packages', entry.name)
    return { dir, dirName: entry.name, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
  })
  .filter((plugin) => plugin.pkg.dsh !== undefined)

let selected = only === 'all' ? plugins : plugins.filter((p) => p.pkg.name === only || unscoped(p.pkg.name) === only || p.dirName === only)
if (selected.length === 0) {
  console.error(`no installable package matches "${only}" (available: ${plugins.map((p) => p.pkg.name).join(', ') || 'none'})`)
  process.exit(1)
}

if (!remove) {
  const unbuilt = selected.filter((plugin) => !existsSync(join(plugin.dir, 'lib', 'client.js')))
  if (only !== 'all' && unbuilt.length > 0) {
    // Asked for by name: a missing build is an error.
    console.error(`${unbuilt[0].pkg.name}: lib/client.js is missing — run \`npm run build\` first`)
    process.exit(1)
  }
  // Installing everything: skip packages whose client half is not built yet, and say so.
  for (const plugin of unbuilt) console.warn(`skip ${plugin.pkg.name}: lib/client.js is not built (run \`npm run build\`)`)
  selected = selected.filter((plugin) => !unbuilt.includes(plugin))
  if (selected.length === 0) {
    console.error('nothing to install: no selected package is built')
    process.exit(1)
  }
}

/**
 * Installing from a git clone: the clone and the commit the copy was built from. Written beside each installed
 * package as install-source.json so the terminal plugin's "Update from source" knows which clone to pull and build.
 * A release archive has no .git, so its installs carry no source and the update stays unavailable.
 */
const source = (() => {
  if (!existsSync(join(root, '.git'))) return null
  let commit = null
  try {
    commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
  } catch {}
  return { repo: root, commit, installedAt: new Date().toISOString() }
})()

/** True when the copy's package.json names `old` and points at this project's repository. */
function hasOwnRepository(target, old) {
  try {
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    return pkg.name === old && typeof repository === 'string' && OWN_REPOSITORY.test(repository)
  } catch {
    return false
  }
}

/**
 * The previously unscoped copy of a scoped plugin in this profile, as {name, target, state, detail}:
 * state is 'ours' (installed from this project: replace it), 'foreign' (a folder of that name that does not come from
 * this project: leave it), 'foreign-entry' (no folder, but the manifest lists a spec or bundle we cannot prove is ours:
 * leave it) or 'manifest-only' (listed with the spec only this installer writes but its folder is gone: drop the dead entry).
 * A copy is ours when its repository is this project's, when the manifest holds exactly `file:./node_modules/<old>`
 * (what `dsh plugin add` never records), or when install-source.json sits in it (only this installer writes that).
 * Null when the plugin has no scope or the profile never had the old name.
 */
function legacyCopy(profileDir, name, manifest) {
  const old = unscoped(name)
  if (old === name) return null
  const target = join(profileDir, 'node_modules', old)
  const spec = manifest.dependencies?.[old]
  const ownSpec = spec === `file:./node_modules/${old}`
  if (existsSync(target)) {
    const ours = ownSpec || existsSync(join(target, 'install-source.json')) || hasOwnRepository(target, old)
    return { name: old, target, state: ours ? 'ours' : 'foreign' }
  }
  const bundled = (manifest.dsh?.profile?.bundles ?? []).includes(old)
  if (spec === undefined && !bundled) return null
  if (ownSpec) return { name: old, target, state: 'manifest-only' }
  const detail = spec === undefined ? 'only in dsh.profile.bundles' : `dependency "${spec}"`
  return { name: old, target, state: 'foreign-entry', detail }
}

/** Read and parse a profile's package.json: {manifest} or {error} (missing, unreadable, invalid JSON or not an object). */
function readManifest(profileDir) {
  let text
  try {
    text = readFileSync(join(profileDir, 'package.json'), 'utf8')
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'package.json is missing' : `package.json cannot be read (${error.message})` }
  }
  try {
    const manifest = JSON.parse(text)
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return { error: 'package.json is not a JSON object' }
    return { manifest }
  } catch (error) {
    return { error: `package.json is not valid JSON (${error.message})` }
  }
}

/**
 * Add or drop one package in one profile manifest (the parsed `manifest`, updated in place and written back).
 * `old` is the unscoped name this package replaces: on install the first entry of either name becomes `name` at that
 * position in the bundle list (the order is the load order) and further entries of either name go; on remove both go.
 */
function reconcileManifest(profileDir, manifest, name, old = null) {
  const manifestPath = join(profileDir, 'package.json')
  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (old !== null) delete manifest.dependencies[old]
  if (remove) {
    delete manifest.dependencies[name]
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((entry) => entry !== name && entry !== old)
  } else {
    manifest.dependencies[name] = `file:./node_modules/${name}`
    const bundles = []
    for (const entry of manifest.dsh.profile.bundles) {
      if (entry !== name && entry !== old) bundles.push(entry)
      else if (!bundles.includes(name)) bundles.push(name)
    }
    if (!bundles.includes(name)) bundles.push(name)
    manifest.dsh.profile.bundles = bundles
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Delete `node_modules/@scope` once its last package is gone. */
function dropEmptyScope(target) {
  const scopeDir = dirname(target)
  try {
    if (readdirSync(scopeDir).length === 0) rmdirSync(scopeDir)
  } catch {}
}

const prefix = dryRun ? '[dry-run] ' : ''
let skippedManifests = 0
for (const profile of profiles) {
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) {
    console.warn(`skip ${profile}: ${profileDir} does not exist`)
    continue
  }
  // Parse the manifest before anything is deleted or copied, so a bad profile is left exactly as it was.
  const read = readManifest(profileDir)
  if (read.error !== undefined) {
    console.warn(`skip ${profile}: ${read.error} (${join(profileDir, 'package.json')}); nothing was changed`)
    skippedManifests++
    continue
  }
  const manifest = read.manifest

  for (const { dir, pkg } of selected) {
    const name = pkg.name
    const target = join(profileDir, 'node_modules', name)
    const legacy = legacyCopy(profileDir, name, manifest)
    const replaced = legacy !== null && (legacy.state === 'ours' || legacy.state === 'manifest-only') ? legacy : null
    if (legacy !== null && replaced === null) {
      const what = legacy.state === 'foreign' ? `${legacy.target} is a package named ${legacy.name}` : `the ${profile} manifest lists ${legacy.name} (${legacy.detail})`
      console.warn(remove
        ? `${profile}: not removed: ${what} that does not come from this project`
        : `${profile}: ${what} that does not come from this project; leaving it alone (it may clash with ${name})`)
    }

    if (remove) {
      console.log(`${prefix}remove ${target} and drop ${name} from the ${profile} manifest`)
      if (replaced !== null) console.log(`${prefix}remove the older unscoped copy ${replaced.target} and drop ${replaced.name} from the ${profile} manifest`)
      if (!dryRun) {
        rmSync(target, { recursive: true, force: true })
        if (replaced !== null) rmSync(replaced.target, { recursive: true, force: true })
        if (name !== unscoped(name)) dropEmptyScope(target)
        reconcileManifest(profileDir, manifest, name, replaced?.name ?? null)
        console.log(`removed ${name} from ${profile} — restart the GUI to unload it`)
      }
      continue
    }

    console.log(`${prefix}install ${name}: ${dir} -> ${target} (package.json, cordis.patch.yml, lib/)`)
    if (replaced !== null) console.log(`${prefix}replace the older unscoped copy ${replaced.target} (${replaced.name}) with ${name}`)
    if (dryRun) continue
    if (replaced !== null) rmSync(replaced.target, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const file of ['package.json', 'cordis.patch.yml']) {
      cpSync(join(dir, file), join(target, file))
    }
    cpSync(join(dir, 'lib'), join(target, 'lib'), { recursive: true })
    if (source !== null) writeFileSync(join(target, 'install-source.json'), `${JSON.stringify(source, null, 2)}\n`)
    reconcileManifest(profileDir, manifest, name, replaced?.name ?? null)
    console.log(`installed ${name} -> ${target}`)
  }
}
if (skippedManifests > 0) process.exitCode = 1
