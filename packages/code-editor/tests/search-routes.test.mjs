import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, startHost, tempDir, tempRepo, write } from './helpers/harness.mjs'
import { expandBraces, expandGlob, findMatches, buildMatcher, gitPathspecs, makePreview, parseGlobs, pathFilter } from '../lib/search-match.js'

after(cleanup)

const search = (host, root, extra = {}) => host.get('/search', { root, ...extra })
const flat = (json) => json.results.flatMap((r) => r.matches.map((m) => `${r.path}:${m.line}:${m.col}:${m.length}`))
const BASE = { 'src/a.ts': 'const Foo = 1\nlet foo = Foo + foo\n', 'src/b.md': 'say foo\n', 'README.md': 'nothing\n' }

async function gitRoot(files = {}) {
  const repo = tempRepo({ ...BASE, ...files })
  const host = await startHost()
  await host.register(repo)
  return { host, root: repo }
}

async function plainRoot(files = {}) {
  const dir = tempDir()
  write(dir, { ...BASE, ...files })
  const host = await startHost()
  await host.register(dir)
  return { host, root: dir }
}

for (const [label, make] of [['git grep', gitRoot], ['walk', plainRoot]]) {
  test(`${label}: literal, case, word, regex flags`, async () => {
    const { host, root } = await make()
    const insens = await search(host, root, { q: 'foo' })
    assert.equal(insens.status, 200)
    assert.deepEqual(flat(insens.json), ['src/a.ts:1:7:3', 'src/a.ts:2:5:3', 'src/a.ts:2:11:3', 'src/a.ts:2:17:3', 'src/b.md:1:5:3'])
    assert.equal(insens.json.truncated, false)
    assert.equal(typeof insens.json.took, 'number')
    assert.equal(insens.json.results[0].matches[0].preview, 'const Foo = 1')

    const sensitive = await search(host, root, { q: 'foo', case: '1' })
    assert.deepEqual(flat(sensitive.json), ['src/a.ts:2:5:3', 'src/a.ts:2:17:3', 'src/b.md:1:5:3'])

    const word = await search(host, root, { q: 'fo', word: '1' })
    assert.equal(flat(word.json).length, 0)
    const word2 = await search(host, root, { q: 'foo', word: '1', case: '1' })
    assert.equal(flat(word2.json).length, 3)

    // Without the regex flag the pattern is literal.
    assert.equal(flat((await search(host, root, { q: 'fo+' })).json).length, 0)
    const re = await search(host, root, { q: 'F\\w+ =', regex: '1', case: '1' })
    assert.deepEqual(flat(re.json), ['src/a.ts:1:7:5'])
  })

  test(`${label}: include / exclude globs`, async () => {
    const { host, root } = await make({ 'lib/c.ts': 'foo\n', 'lib/deep/d.ts': 'foo\n' })
    const md = await search(host, root, { q: 'foo', include: '*.md' })
    assert.deepEqual(md.json.results.map((r) => r.path), ['src/b.md'])
    const dir = await search(host, root, { q: 'foo', include: 'lib' })
    assert.deepEqual(dir.json.results.map((r) => r.path), ['lib/c.ts', 'lib/deep/d.ts'])
    const both = await search(host, root, { q: 'foo', include: '*.ts, *.md', exclude: 'deep, src/b.md' })
    assert.deepEqual(both.json.results.map((r) => r.path), ['lib/c.ts', 'src/a.ts'])
    const braces = await search(host, root, { q: 'foo', include: '*.{md,ts}', exclude: 'lib/**' })
    assert.deepEqual(braces.json.results.map((r) => r.path), ['src/a.ts', 'src/b.md'])
    const onlyExclude = await search(host, root, { q: 'foo', exclude: '*.ts' })
    assert.deepEqual(onlyExclude.json.results.map((r) => r.path), ['src/b.md'])
  })

  test(`${label}: binary files are skipped, previews are trimmed around the match`, async () => {
    const { host, root } = await make({
      'bin.dat': Buffer.concat([Buffer.from('foo\n'), Buffer.from([0, 1, 2])]).toString('latin1'),
      'long.txt': `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}\n`,
      'tab.txt': '\t\t  needle here\n',
    })
    // write() stored bin.dat as utf8 text; make the NUL byte explicit for both engines
    writeFileSync(join(root, 'bin.dat'), Buffer.concat([Buffer.from('foo\n'), Buffer.from([0, 1, 2])]))
    const bin = await search(host, root, { q: 'foo' })
    assert.ok(!bin.json.results.some((r) => r.path === 'bin.dat'))
    const sensitive = await search(host, root, { q: 'needle', case: '1' })
    assert.equal(sensitive.json.results.length, 1) // tab.txt only: NEEDLE differs by case
    const longCi = await search(host, root, { q: 'needle' })
    const m = longCi.json.results.find((r) => r.path === 'long.txt').matches[0]
    assert.equal(m.col, 501)
    assert.ok(m.preview.length <= 260 && m.preview.length >= 100, `preview length ${m.preview.length}`)
    assert.ok(m.preview.includes('NEEDLE'))
    assert.equal(m.preview.slice(m.at, m.at + m.length), 'NEEDLE')
    const t = longCi.json.results.find((r) => r.path === 'tab.txt').matches[0]
    assert.equal(t.col, 5)
    assert.equal(t.preview, 'needle here')
  })

  test(`${label}: caps - 2000 matches and 200 files`, async () => {
    const lines = Array.from({ length: 2500 }, () => 'hit').join('\n')
    const { host, root } = await make({ 'many.txt': lines })
    const r = await search(host, root, { q: 'hit' })
    assert.equal(r.json.truncated, true)
    assert.equal(r.json.results.reduce((n, x) => n + x.matches.length, 0), 2000)
    const small = await search(host, root, { q: 'hit', max: '10' })
    assert.equal(small.json.results.reduce((n, x) => n + x.matches.length, 0), 10)
    assert.equal(small.json.truncated, true)

    const files = {}
    for (let i = 0; i < 230; i++) files[`f/${String(i).padStart(3, '0')}.txt`] = 'zzz\n'
    const { host: h2, root: r2 } = await make(files)
    const many = await search(h2, r2, { q: 'zzz' })
    assert.equal(many.json.results.length, 200)
    assert.equal(many.json.truncated, true)
  })

  test(`${label}: bad requests`, async () => {
    const { host, root } = await make()
    assert.equal((await search(host, root, { q: '' })).status, 400)
    assert.equal((await search(host, root, { q: 'x'.repeat(1001) })).status, 400)
    const bad = await search(host, root, { q: '(', regex: '1' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.code, 'bad-pattern')
    assert.equal((await search(host, root, { q: 'a', include: '../x' })).status, 400)
    assert.equal((await search(host, root, { q: 'a\nb' })).status, 400)
  })
}

test('confinement: unregistered roots, missing root, symlinks and .git are not searched', async () => {
  const outside = tempDir()
  write(outside, { 'secret.txt': 'foo secret\n' })
  const host = await startHost()
  assert.equal((await search(host, outside, { q: 'foo' })).status, 403)
  assert.equal((await host.get('/search', { q: 'foo' })).status, 400)

  const dir = tempDir()
  write(dir, { 'ok.txt': 'foo\n' })
  try {
    symlinkSync(outside, join(dir, 'link'), 'junction')
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'secret-link.txt'))
  } catch {}
  await host.register(dir)
  const r = await search(host, dir, { q: 'foo' })
  assert.deepEqual(r.json.results.map((x) => x.path), ['ok.txt'])

  const repo = tempRepo({ 'a.txt': 'foo\n' })
  await host.register(repo)
  const g = await search(host, repo, { q: 'foo' })
  assert.deepEqual(g.json.results.map((x) => x.path), ['a.txt']) // .git internals never match
  assert.equal((await host.get('/search', { root: repo, q: 'foo' }, { origin: 'http://evil.example' })).status, 403)
})

test('git: untracked files are searched, ignored ones are not, sub-folder roots are scoped', async () => {
  const repo = tempRepo({ 'a.txt': 'foo\n', '.gitignore': 'ign.txt\n', 'sub/s.txt': 'foo\n', 'other/o.txt': 'foo\n' })
  write(repo, { 'new.txt': 'foo\n', 'ign.txt': 'foo\n' })
  const host = await startHost()
  await host.register(repo, join(repo, 'sub'))
  const all = await search(host, repo, { q: 'foo' })
  assert.deepEqual(all.json.results.map((r) => r.path), ['a.txt', 'new.txt', 'other/o.txt', 'sub/s.txt'])
  const sub = await search(host, join(repo, 'sub'), { q: 'foo' })
  assert.deepEqual(sub.json.results.map((r) => r.path), ['s.txt'])
})

test('non-ASCII text gets UTF-16 columns', async () => {
  for (const make of [gitRoot, plainRoot]) {
    const { host, root } = await make({ 'u.txt': 'ąę \u{1F600} foo\n' })
    const r = await search(host, root, { q: 'foo' })
    const m = r.json.results.find((x) => x.path === 'u.txt').matches[0]
    assert.equal(m.col, 7) // 'ąę ' = 3, the emoji is 2 UTF-16 units, then a space
  }
})

test('timeout: a catastrophic regex returns partial results flagged timedOut instead of hanging', async () => {
  const dir = tempDir()
  write(dir, { 'a-first.txt': 'aa\n', 'z-bad.txt': `${'a'.repeat(40)}!\n` })
  const host = await startHost({ searchTimeoutMs: 700 })
  await host.register(dir)
  const t0 = Date.now()
  const r = await search(host, dir, { q: '(a+)+$', regex: '1' })
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(r.status, 200)
  assert.equal(r.json.timedOut, true)
  assert.equal(r.json.truncated, true)
  assert.deepEqual(r.json.results.map((x) => x.path), ['a-first.txt']) // what was found before the stall is kept
  // The host is still responsive.
  assert.equal((await search(host, dir, { q: 'aa', include: 'a-first.txt' })).json.results.length, 1)

  const repo = tempRepo({ 'b.txt': `${'a'.repeat(40)}!\n` })
  await host.register(repo)
  const g = await search(host, repo, { q: '(a+)+$', regex: '1' })
  assert.equal(g.status, 200)
})

test('raw: images only, size cap, confinement, safe headers', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, 'img'))
  writeFileSync(join(dir, 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'img', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
  writeFileSync(join(dir, 'notes.txt'), 'text')
  writeFileSync(join(dir, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1))
  const outside = tempDir()
  writeFileSync(join(outside, 'o.png'), 'x')
  const host = await startHost()
  await host.register(dir)
  const get = (query) => {
    const url = new URL(`http://127.0.0.1:${host.port}/api/dsh-code-editor/raw`)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    return fetch(url)
  }
  const status = async (query) => {
    const res = await get(query)
    await res.arrayBuffer()
    return res.status
  }
  const png = await get({ root: dir, path: 'img/a.png' })
  assert.equal(png.status, 200)
  assert.equal(png.headers.get('content-type'), 'image/png')
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47])
  const svg = await get({ root: dir, path: 'img/x.svg' })
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
  assert.match(svg.headers.get('content-security-policy'), /sandbox/)
  await svg.arrayBuffer()
  assert.equal(await status({ root: dir, path: 'notes.txt' }), 415)
  assert.equal(await status({ root: dir, path: 'big.png' }), 413)
  assert.equal(await status({ root: dir, path: `../${outside.split(/[\\/]/).pop()}/o.png` }), 403)
  assert.equal(await status({ root: dir, path: 'missing.png' }), 404)
  assert.equal(await status({ root: outside, path: 'o.png' }), 403)
  assert.equal(await status({ root: dir, path: '.git/x.png' }), 403)
})

test('search-match: globs, matcher, preview helpers', () => {
  assert.deepEqual(parseGlobs('*.ts, src/{a,b}/**,  ,./x'), ['*.ts', 'src/{a,b}/**', 'x'])
  assert.throws(() => parseGlobs('a/../b'))
  assert.deepEqual(expandBraces('a{b,c}d'), ['abd', 'acd'])
  assert.deepEqual(expandBraces('{a,b{c,d}}'), ['a', 'bc', 'bd'])
  assert.deepEqual(expandBraces('a{b'), ['a{b'])
  assert.deepEqual(expandGlob('*.ts'), ['**/*.ts', '**/*.ts/**'])
  assert.deepEqual(expandGlob('src/lib/'), ['src/lib', 'src/lib/**'])
  assert.deepEqual(gitPathspecs([], ['x']), ['.', ':(glob,exclude)**/x', ':(glob,exclude)**/x/**'])
  const f = pathFilter(['*.ts'], ['gen'])
  assert.ok(f('a.ts') && f('x/y/a.ts') && !f('a.js') && !f('gen/a.ts') && !f('x/gen/a.ts'))
  const { re } = buildMatcher({ q: 'a.b', regex: false, caseSensitive: true, word: false })
  assert.equal(findMatches('a.b axb a.b', re).length, 2)
  const w = buildMatcher({ q: 'cat', regex: false, caseSensitive: false, word: true })
  assert.deepEqual(findMatches('cat concat cat_ Cat', w.re).map((m) => m.index), [0, 16])
  assert.deepEqual(makePreview('   hi there', 3, 2), { preview: 'hi there', at: 0 })
})
