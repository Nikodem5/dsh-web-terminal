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
//        --dry-run prints what would be copied or removed without writing anything.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/** Installable plugins: packages/* whose manifest carries a `dsh` block (placeholders have none). */
const plugins = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
  .map((entry) => {
    const dir = join(root, 'packages', entry.name)
    return { dir, dirName: entry.name, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
  })
  .filter((plugin) => plugin.pkg.dsh !== undefined)

let selected = only === 'all' ? plugins : plugins.filter((p) => p.pkg.name === only || p.dirName === only)
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

/** Add or drop one package in one profile manifest. */
function reconcileManifest(profileDir, name) {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (remove) {
    delete manifest.dependencies[name]
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((entry) => entry !== name)
  } else {
    manifest.dependencies[name] = `file:./node_modules/${name}`
    if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const prefix = dryRun ? '[dry-run] ' : ''
for (const profile of profiles) {
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) {
    console.warn(`skip ${profile}: ${profileDir} does not exist`)
    continue
  }

  for (const { dir, pkg } of selected) {
    const name = pkg.name
    const target = join(profileDir, 'node_modules', name)

    if (remove) {
      console.log(`${prefix}remove ${target} and drop ${name} from the ${profile} manifest`)
      if (!dryRun) {
        rmSync(target, { recursive: true, force: true })
        reconcileManifest(profileDir, name)
        console.log(`removed ${name} from ${profile} — restart the GUI to unload it`)
      }
      continue
    }

    console.log(`${prefix}install ${name}: ${dir} -> ${target} (package.json, cordis.patch.yml, lib/)`)
    if (dryRun) continue
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    for (const file of ['package.json', 'cordis.patch.yml']) {
      cpSync(join(dir, file), join(target, file))
    }
    cpSync(join(dir, 'lib'), join(target, 'lib'), { recursive: true })
    if (source !== null) writeFileSync(join(target, 'install-source.json'), `${JSON.stringify(source, null, 2)}
`)
    reconcileManifest(profileDir, name)
    console.log(`installed ${name} -> ${target}`)
  }
}
