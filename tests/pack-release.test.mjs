import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { releaseReadme } from '../scripts/pack-release.mjs'

const root = join(fileURLToPath(import.meta.url), '..', '..')

test('release README names the installer commands', () => {
  const text = releaseReadme('9.9.9')
  assert.match(text, /9\.9\.9/)
  assert.match(text, /node install\.mjs desktop/)
  assert.match(text, /--remove/)
})

test('pack output layout (when packed)', { skip: !existsSync(join(root, 'dist')) }, async () => {
  const { pack } = await import('../scripts/pack-release.mjs')
  const { dir } = pack()
  for (const f of ['install.mjs', 'README.md', 'LICENSE', 'packages/terminal/package.json', 'packages/terminal/cordis.patch.yml',
    'packages/terminal/lib/client.js', 'packages/terminal/lib/shell/integration.ps1', 'packages/terminal/lib/shared',
    'packages/code-editor/package.json', 'packages/code-editor/lib/client.js', 'packages/code-editor/lib/shared']) {
    assert.ok(existsSync(join(dir, f)), f)
  }
})
