// Builds the release archive: dist/dsh-plugins-<version>/ and dist/dsh-plugins-<version>.zip.
// Run `npm run build` first (or use `npm run pack`). No dependencies.
//
// Archive layout:
//   install.mjs  README.md  LICENSE
//   packages/terminal/{package.json,cordis.patch.yml,lib/}
//   packages/code-editor/{package.json,cordis.patch.yml,lib/}
// install.mjs is scripts/install.mjs unchanged: it installs from the sibling packages/ folder.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const PLUGINS = ['terminal', 'code-editor']

export const releaseReadme = (v) => `# DeepSeek Harness plugins ${v}

Two plugins for the DeepSeek Harness desktop app: **dsh-web-terminal** (Terminals page) and **dsh-code-editor** (Code page).
Requires Node.js 22+ on PATH. Full documentation: https://github.com/Nikodem5/dsh-web-terminal

## Install

1. Close the DeepSeek Harness app.
2. In this folder run \`node install.mjs desktop\` (or \`node install.mjs web\`; with no profile it installs into both).
3. Start the app.

Preview first with \`node install.mjs --dry-run desktop\`. Use \`--package dsh-web-terminal\` or \`--package dsh-code-editor\`
to install only one plugin.

## Update

Close the app, download the newer archive, unzip it and run \`node install.mjs desktop\` again. It replaces the
installed copies.

## Remove

Close the app and run \`node install.mjs --remove desktop\`.

The installer uses \`~/.dsh\` (or \`DSH_HOME\` if set) and only touches the plugin folders and the profile's package.json.
License: MIT (see LICENSE).
`

export function pack() {
  for (const name of PLUGINS) {
    if (!existsSync(join(root, 'packages', name, 'lib', 'client.js'))) {
      throw new Error(`packages/${name}/lib/client.js is missing: run \`npm run build\` first`)
    }
  }
  const dist = join(root, 'dist')
  const base = `dsh-plugins-${version}`
  const dir = join(dist, base)
  const zip = join(dist, `${base}.zip`)
  rmSync(dir, { recursive: true, force: true })
  rmSync(zip, { force: true })
  rmSync(join(dist, `${base}.tar.gz`), { force: true })
  mkdirSync(dir, { recursive: true })

  cpSync(join(root, 'scripts', 'install.mjs'), join(dir, 'install.mjs'))
  cpSync(join(root, 'LICENSE'), join(dir, 'LICENSE'))
  writeFileSync(join(dir, 'README.md'), releaseReadme(version))
  for (const name of PLUGINS) {
    const from = join(root, 'packages', name)
    const to = join(dir, 'packages', name)
    mkdirSync(to, { recursive: true })
    for (const file of ['package.json', 'cordis.patch.yml']) cpSync(join(from, file), join(to, file))
    cpSync(join(from, 'lib'), join(to, 'lib'), { recursive: true })
  }

  let archive = zip
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dist, stdio: 'inherit' }).status === 0
  // Relative names + cwd=dist: GNU tar (e.g. from Git Bash) misreads `C:` as a remote host. On Windows prefer the
  // system bsdtar, which writes .zip with -a.
  const winTar = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe')
  let ok = process.platform === 'win32'
    ? run(existsSync(winTar) ? winTar : 'tar', ['-a', '-cf', `${base}.zip`, base])
    : spawnSync('zip', ['-q', '-r', `${base}.zip`, base], { cwd: dist }).status === 0
  if (!ok) {
    archive = join(dist, `${base}.tar.gz`)
    rmSync(zip, { force: true })
    ok = run('tar', ['-czf', `${base}.tar.gz`, base])
  }
  if (!ok) throw new Error('could not create an archive (need `zip` or `tar`)')
  return { dir, archive, size: statSync(archive).size }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, archive, size } = pack()
  console.log(`folder:  ${dir}`)
  console.log(`archive: ${archive} (${(size / 1024 / 1024).toFixed(2)} MiB)`)
}
