// Copies the host helpers shared with the other plugins (packages/shared/host) into lib/shared/.
// An installed package cannot reach packages/shared, so the helpers must live inside it.
// build.mjs calls copySharedHost(); `node scripts/copy-shared-host.mjs` runs it directly (also before tests).
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Replace lib/shared/ with a fresh copy of packages/shared/host. */
export function copySharedHost() {
  const from = join(pkgDir, '..', 'shared', 'host')
  const to = join(pkgDir, 'lib', 'shared')
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
  return to
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) copySharedHost()
