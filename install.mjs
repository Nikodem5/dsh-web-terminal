// Installs this plugin into one or more dsh profiles as a real package copy.
//
// Why a copy and not `dsh plugin add <path>`: that records a `link:` dependency,
// which mounts the package through a junction in the profile's node_modules
// pointing at this workspace. The client-modules registry resolves each loader
// row's manifest relative to the profile tree, and a package whose real path
// lives outside that tree is skipped — the host half still mounts, but the
// browser half never reaches the client bundle graph. Copying `lib/` plus the
// two manifests into the profile keeps the package physically inside the tree.
//
// Usage: node install.mjs [profile ...]      (default: desktop web)
//        node install.mjs --remove [profile ...]

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const args = process.argv.slice(2)
const remove = args.includes('--remove')
const profiles = args.filter((arg) => !arg.startsWith('--'))
if (profiles.length === 0) profiles.push('desktop', 'web')

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const name = pkg.name

if (!remove && !existsSync(join(here, 'lib', 'client.js'))) {
  console.error('lib/client.js is missing — run `npm run build` first')
  process.exit(1)
}

/** Add or drop this package in one profile manifest. */
function reconcileManifest(profileDir) {
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

for (const profile of profiles) {
  const profileDir = join(home, 'profiles', profile)
  if (!existsSync(profileDir)) {
    console.warn(`skip ${profile}: ${profileDir} does not exist`)
    continue
  }

  const target = join(profileDir, 'node_modules', name)
  rmSync(target, { recursive: true, force: true })

  if (remove) {
    reconcileManifest(profileDir)
    console.log(`removed ${name} from ${profile} — restart the GUI to unload it`)
    continue
  }

  mkdirSync(target, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml']) {
    cpSync(join(here, file), join(target, file))
  }
  cpSync(join(here, 'lib'), join(target, 'lib'), { recursive: true })
  reconcileManifest(profileDir)

  const copied = existsSync(join(target, 'lib', 'client.js')) ? 'with client bundle' : 'WITHOUT client bundle'
  console.log(`installed ${name} -> ${target} (${copied})`)
}
