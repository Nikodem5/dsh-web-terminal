import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  assert.ok(text.includes('@nikodem5/dsh-web-terminal'))
  assert.ok(text.includes('@nikodem5/dsh-code-editor'))
})

// Packs into a throwaway folder, so the real dist/ is never touched; needs the plugins built.
const built = ['terminal', 'code-editor'].every((name) => existsSync(join(root, 'packages', name, 'lib', 'client.js')))

test('pack output layout (when built)', { skip: !built }, async () => {
  const { pack } = await import('../scripts/pack-release.mjs')
  const out = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  try {
    const { dir } = pack(out)
    for (const f of ['install.mjs', 'README.md', 'LICENSE', 'packages/terminal/package.json', 'packages/terminal/cordis.patch.yml',
      'packages/terminal/lib/client.js', 'packages/terminal/lib/shell/integration.ps1', 'packages/terminal/lib/shared',
      'packages/code-editor/package.json', 'packages/code-editor/lib/client.js', 'packages/code-editor/lib/shared']) {
      assert.ok(existsSync(join(dir, f)), f)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
