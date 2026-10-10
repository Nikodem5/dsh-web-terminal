// Thin wrapper: the installer lives at the repo root. Same arguments as scripts/install.mjs.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'install.mjs')
const result = spawnSync(process.execPath, [script, '--package', 'dsh-web-terminal', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
