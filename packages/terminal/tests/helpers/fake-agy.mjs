// A stand-in for `agy plugin install <dir>` / `agy plugin uninstall <name>` in host tests: it copies the
// manifest into $DSH_WT_GEMINI_DIR/config/plugins/<name> (a temp folder) or deletes it. Nothing else.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [command, action, target] = process.argv.slice(2)
const gemini = process.env.DSH_WT_GEMINI_DIR
if (command !== 'plugin' || !gemini) process.exit(2)
if (action === 'install') {
  const manifest = JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8'))
  const dest = join(gemini, 'config', 'plugins', manifest.name)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'plugin.json'), JSON.stringify(manifest))
  console.log(`Installed ${manifest.name} to ${dest}`)
} else if (action === 'uninstall') {
  rmSync(join(gemini, 'config', 'plugins', target), { recursive: true, force: true })
} else process.exit(2)
