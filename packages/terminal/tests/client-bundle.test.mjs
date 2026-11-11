// esbuild does not type check, so a merge that leaves two of the same import or two `export *` with a clashing
// name builds green and breaks at runtime. These guards make that fail `npm run build` and `npm test`.
//
//   node --test tests/client-bundle.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { STRICT_LOG_OVERRIDES, duplicateImports, findDuplicateImports } from '../check-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = join(root, 'src', 'client')

test('no client source imports the same name twice', () => {
  assert.deepEqual(findDuplicateImports(client), [])
})

test('the client bundles with no esbuild error or warning (ambiguous re-exports count)', async () => {
  for (const entry of ['index.ts', 'terminal-store.ts']) {
    const result = await build({
      entryPoints: [join(client, entry)],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      jsx: 'automatic',
      write: false,
      logLevel: 'silent',
      logOverride: STRICT_LOG_OVERRIDES,
      absWorkingDir: root,
      alias: { react: join(root, 'src', 'shims', 'react.cts'), 'react/jsx-runtime': join(root, 'src', 'shims', 'jsx-runtime.cts') },
    })
    assert.deepEqual(result.errors.map((m) => m.text), [], entry)
    assert.deepEqual(result.warnings.map((m) => m.text), [], entry)
  }
})

test('duplicateImports finds a name imported twice, however it is bound', () => {
  assert.deepEqual(duplicateImports("import { Notices } from './a.tsx'\nimport { Notices } from './b.tsx'\n"), ['Notices'])
  assert.deepEqual(duplicateImports("import { a as X } from './a.ts'\nimport X from './b.ts'\n"), ['X'])
  assert.deepEqual(duplicateImports("import {\n  a,\n  b,\n} from './a.ts'\nimport type { b } from './b.ts'\n"), ['b'])
  assert.deepEqual(duplicateImports("import { a } from './a.ts'\nimport { b } from './b.ts'\nimport * as c from './c.ts'\n"), [])
})

test('an `export *` name clash fails the bundle under the strict overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-bundle-'))
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'b.ts'), 'export const x = 2\n')
    writeFileSync(join(dir, 'barrel.ts'), "export * from './a.ts'\nexport * from './b.ts'\n")
    const run = (overrides) => build({ entryPoints: [join(dir, 'barrel.ts')], bundle: true, format: 'esm', write: false, logLevel: 'silent', logOverride: overrides })
    await run({}) // without the override esbuild stays quiet
    await assert.rejects(run(STRICT_LOG_OVERRIDES), (e) => e.errors.some((m) => /ambiguous/.test(m.text)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
