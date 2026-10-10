// Unit tests for path detection in terminal text (src/client/paths.ts).
//
//   npm test   (or: node --test tests/paths.test.mjs)

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let p
before(async () => {
  const out = await build({ entryPoints: [join(root, 'src', 'client', 'paths.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent' })
  p = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
})

/** [linked text, path, line, col] for each match. */
const found = (text) => p.findPaths(text).map((m) => [text.slice(m.start, m.end), m.path, m.line, m.col])
/** Just the paths. */
const paths = (text) => p.findPaths(text).map((m) => m.path)

test('Windows absolute paths, both slash styles, with position suffixes', () => {
  assert.deepEqual(found('error in C:\\a\\b.ts: bad'), [['C:\\a\\b.ts', 'C:\\a\\b.ts', undefined, undefined]])
  assert.deepEqual(found('C:\\a\\b.ts:12:5: bad'), [['C:\\a\\b.ts:12:5', 'C:\\a\\b.ts', 12, 5]])
  assert.deepEqual(found('at fn (C:/x/y.js:3:4)'), [['C:/x/y.js:3:4', 'C:/x/y.js', 3, 4]])
  assert.deepEqual(paths('D:\\proj'), ['D:\\proj'])
})

test('UNC paths', () => {
  assert.deepEqual(paths('copy \\\\srv\\share\\dir\\f.txt done'), ['\\\\srv\\share\\dir\\f.txt'])
})

test('POSIX absolute, home and relative shapes', () => {
  assert.deepEqual(paths('/usr/lib/x.so'), ['/usr/lib/x.so'])
  assert.deepEqual(paths('edit ~/notes/a.md now'), ['~/notes/a.md'])
  assert.deepEqual(paths('src/a.ts ./b.ts ../c.ts'), ['src/a.ts', './b.ts', '../c.ts'])
  assert.deepEqual(paths('src\\win\\a.ts'), ['src\\win\\a.ts'])
  assert.deepEqual(paths('README.md package-lock.json .gitignore'), ['README.md', 'package-lock.json', '.gitignore'])
  assert.deepEqual(paths('a directory src/ here'), ['src/'])
})

test('position suffix forms', () => {
  assert.deepEqual(found('src/a.ts:12'), [['src/a.ts:12', 'src/a.ts', 12, undefined]])
  assert.deepEqual(found('src/a.ts:12:5'), [['src/a.ts:12:5', 'src/a.ts', 12, 5]])
  assert.deepEqual(found('src/a.ts(12,5): error'), [['src/a.ts(12,5)', 'src/a.ts', 12, 5]])
  assert.deepEqual(found('src/a.ts(12): error'), [['src/a.ts(12)', 'src/a.ts', 12, undefined]])
  assert.deepEqual(found('see a.ts#L12'), [['a.ts#L12', 'a.ts', 12, undefined]])
  assert.deepEqual(found('see a.ts#L12-L20'), [['a.ts#L12-L20', 'a.ts', 12, undefined]])
  assert.deepEqual(found('see a.ts line 12'), [['a.ts line 12', 'a.ts', 12, undefined]])
  assert.deepEqual(found('at x/y.py, line 7, column 3'), [['x/y.py, line 7, column 3', 'x/y.py', 7, 3]])
  assert.deepEqual(found('a.ts:0'), [], 'line 0 is no position and the colon makes it no path')
})

test('surrounding quotes, brackets and trailing punctuation are stripped', () => {
  assert.deepEqual(paths('see (src/a.ts), ok'), ['src/a.ts'])
  assert.deepEqual(paths('[src/a.ts]'), ['src/a.ts'])
  assert.deepEqual(paths('<src/a.ts>'), ['src/a.ts'])
  assert.deepEqual(paths("'src/a.ts'"), ['src/a.ts'])
  assert.deepEqual(paths('`src/a.ts`'), ['src/a.ts'])
  assert.deepEqual(paths('Failed: src/a.ts.'), ['src/a.ts'])
  assert.deepEqual(paths('src/a.ts; src/b.ts, src/c.ts!'), ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  assert.deepEqual(found('src/a.ts:12:'), [['src/a.ts:12', 'src/a.ts', 12, undefined]])
  assert.deepEqual(found('(src/a.ts:12:5)'), [['src/a.ts:12:5', 'src/a.ts', 12, 5]])
  assert.deepEqual(paths('src/a(1).ts'), ['src/a(1).ts'], 'balanced brackets inside a name stay')
  assert.deepEqual(paths('--out=dist/a.js'), ['dist/a.js'])
})

test('paths with spaces only when quoted', () => {
  assert.deepEqual(paths('open "C:\\Program Files\\x y.txt" now'), ['C:\\Program Files\\x y.txt'])
  assert.deepEqual(paths("cat '/tmp/my dir/a b.txt'"), ['/tmp/my dir/a b.txt'])
  assert.deepEqual(paths('File "/tmp/a b/x.py", line 12, in f'), ['/tmp/a b/x.py'])
  assert.deepEqual(found('File "/tmp/a b/x.py", line 12, in f')[0].slice(2), [12, undefined])
  assert.deepEqual(paths('"my notes.txt"'), ['my notes.txt'])
  // Unquoted, the space ends the path: two separate candidates, neither of which exists.
  assert.deepEqual(paths('C:\\Program Files\\x.txt'), ['C:\\Program', 'Files\\x.txt'])
})

test('an apostrophe in prose does not hide a later quoted path', () => {
  assert.deepEqual(paths("don't open 'my dir/a b.txt' please"), ['my dir/a b.txt'])
})

test('URLs are left to the web-links addon', () => {
  assert.deepEqual(paths('https://example.com/a/b.ts'), [])
  assert.deepEqual(paths('see http://localhost:3000/src/a.ts:12'), [])
  assert.deepEqual(paths('ftp://x/y.txt www.example.com/a.html mailto:me@x.com'), [])
  assert.deepEqual(paths('git@github.com:user/repo.git'), [])
})

test('versions, times, ratios and plain words are not paths', () => {
  assert.deepEqual(paths('v1.2.3 1.2.3 2.0.0-rc.1 0.1.0'), [])
  assert.deepEqual(paths('at 12:30 and 10:30:15'), [])
  assert.deepEqual(paths('ratio 3/4 and 1/2/3, 16:9'), [])
  assert.deepEqual(paths('localhost:3000 key:value'), [])
  assert.deepEqual(paths('hello world // comment'), [])
  assert.deepEqual(paths('100% done... ok -- x'), [])
  assert.deepEqual(paths('word.'), [])
})

test('several paths on one line keep their own positions', () => {
  const text = 'a.ts:1 and src/b.ts:2:3'
  assert.deepEqual(found(text), [['a.ts:1', 'a.ts', 1, undefined], ['src/b.ts:2:3', 'src/b.ts', 2, 3]])
})

test('ranges are exact indexes into the text', () => {
  const text = '  (src/a.ts:12:5),'
  const [m] = p.findPaths(text)
  assert.equal(m.start, 3)
  assert.equal(text.slice(m.start, m.end), 'src/a.ts:12:5')
})

test('a path wrapped over two rows is one match when the rows are joined', () => {
  // The join itself lives in path-links; here the joined text is what findPaths sees.
  const joined = 'error: C:\\Users\\someone\\proj' + '\\src\\deep\\file.ts:44:2'
  assert.deepEqual(found(joined).map((r) => r[1]), ['C:\\Users\\someone\\proj\\src\\deep\\file.ts'])
})
