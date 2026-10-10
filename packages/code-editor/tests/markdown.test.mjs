import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { applyColorized, isMarkdownPath, linkAction, openExternal, renderMarkdown, resolveRelative, slugify } from '../src/client/markdown.ts'
import { MarkdownController } from '../src/client/md-state.ts'
import { sleep, until } from './helpers/fake.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
const win = dom.window
const doc = win.document

/** Render and return `{ html, root, images }` where root is a container holding the fragment. */
function render(src, docDir = '') {
  const r = renderMarkdown(src, { docDir, win })
  const root = doc.createElement('div')
  root.appendChild(r.fragment)
  return { ...r, root, html: root.innerHTML }
}

/** Everything that could run code or load something, anywhere in the tree. */
function assertInert(root) {
  for (const el of root.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      assert.ok(!/^on/i.test(attr.name), `event handler attribute ${attr.name} on <${el.localName}>`)
      assert.notEqual(attr.name, 'style', 'style attribute')
      assert.ok(!/^\s*(javascript|vbscript|data):/i.test(attr.value), `dangerous URL in ${attr.name}`)
    }
    assert.ok(!['script', 'iframe', 'object', 'embed', 'svg', 'math', 'style', 'form', 'link', 'meta', 'base', 'video', 'audio', 'template'].includes(el.localName), `<${el.localName}> survived`)
  }
}

test('renders GFM: headings, tables, task lists, fences, strikethrough, emphasis', () => {
  const { root } = render('# Title\n\nSome *em* and **strong** and ~~gone~~.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n```js\nconst a = 1\n```\n')
  assert.equal(root.querySelector('h1').textContent, 'Title')
  assert.equal(root.querySelector('h1').id, 'ce-md-title')
  assert.ok(root.querySelector('em') && root.querySelector('strong') && root.querySelector('del'))
  assert.equal(root.querySelectorAll('table th').length, 2)
  assert.equal(root.querySelectorAll('table td').length, 2)
  const boxes = [...root.querySelectorAll('input[type=checkbox]')]
  assert.equal(boxes.length, 2)
  assert.ok(boxes.every((b) => b.hasAttribute('disabled')))
  assert.equal(boxes.filter((b) => b.hasAttribute('checked')).length, 1)
  const code = root.querySelector('pre > code')
  assert.equal(code.className, 'language-js')
  assert.equal(code.textContent, 'const a = 1\n')
})

test('XSS: scripts, handlers, javascript: urls, svg/math/style/iframe/form payloads', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<img src="x" onerror="alert(1)">',
    '[click](javascript:alert(1))',
    '[click](JaVaScRiPt:alert(1))',
    '[click](java\tscript:alert(1))',
    '[click](&#106;avascript:alert(1))',
    '[click](vbscript:msgbox(1))',
    '[click](data:text/html,<script>alert(1)</script>)',
    '<a href="javascript:alert(1)">x</a>',
    '<svg onload=alert(1)></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg><style><img src=x onerror=alert(1)></style></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<style>body{display:none}</style>',
    '<p style="position:fixed;inset:0">overlay</p>',
    '<form action="https://evil"><input name=x><button>go</button></form>',
    '<details open ontoggle=alert(1)><summary>x</summary></details>',
    '<body onload=alert(1)>',
    '<meta http-equiv="refresh" content="0;url=https://evil">',
    '<base href="https://evil/">',
    '<link rel="stylesheet" href="https://evil/x.css">',
    '<video src=x onerror=alert(1)></video>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<template><img src=x onerror=alert(1)></template>',
    '<a href="https://x" onclick="alert(1)">x</a>',
    '<div onmouseover="alert(1)">hover</div>',
    '<img src="x" srcset="https://evil/a.png 1x">',
    '<![CDATA[<script>alert(1)</script>]]>',
    '<img/src=x/onerror=alert(1)>',
    '<scr<script>ipt>alert(1)</scr</script>ipt>',
  ]
  for (const p of payloads) {
    const { root, html } = render(p)
    assertInert(root)
    assert.ok(!/onerror|onload|onclick|onmouseover|ontoggle|alert\(1\)<\/script/i.test(html.replace(/&lt;[^]*?&gt;/g, '')) || !root.querySelector('[onerror],[onload]'), p)
    for (const a of root.querySelectorAll('a')) assert.equal(a.getAttribute('href'), null, `${p}: an href survived`)
    for (const img of root.querySelectorAll('img')) assert.equal(img.getAttribute('src'), null, `${p}: an img src survived`)
  }
})

test('XSS: nothing the page acts on can be forged from markdown, classes and ids are stripped', () => {
  const { root } = render('<a href="x.md" data-ce-ext="https://evil.example" data-ce-md="../../etc/passwd">x</a>\n\n<div class="ce-qo-back" id="root">overlay</div>\n\n<img src="x.png" data-ce-img="../../secret.png">\n\n<input type="text" value="phish"><input type="checkbox" checked onclick="alert(1)">')
  const a = root.querySelector('a')
  assert.deepEqual(linkAction(a), { kind: 'md', path: 'x.md', fragment: '' }, 'only the resolved real href counts')
  assert.equal(root.querySelector('div').getAttribute('class'), null)
  assert.equal(root.querySelector('div').getAttribute('id'), null)
  assert.equal(root.querySelector('img').getAttribute('data-ce-img'), 'x.png')
  assert.equal(root.querySelectorAll('input').length, 1, 'only the checkbox stays')
  assert.equal(root.querySelector('input').hasAttribute('onclick'), false)
  assert.ok(root.querySelector('input').hasAttribute('disabled'))
  const cls = render('```js\nx\n```\n\n<code class="ce-notice">y</code>').root
  assert.equal(cls.querySelector('pre code').className, 'language-js')
  assert.equal(cls.querySelectorAll('code')[1].getAttribute('class'), null)
})

test('links: relative markdown opens in the editor, http(s) externally, the rest is inert', () => {
  const { root } = render([
    '[a](other.md)', '[b](../up.md#Some-Heading)', '[c](/rooted.md)', '[d](sub%20dir/x%20y.markdown)', '[e](https://example.com/p?q=1#f)',
    '[f](http://example.com)', '[g](mailto:a@b.c)', '[h](file:///etc/passwd)', '[i](//evil.example/x)', '[j](code.ts)', '[k](#intro-section)', '[l](../../../../escape.md)',
    '[m](C:\\\\Users\\\\x.md)', '[n](tel:123)', '[o](ftp://x/y.md)',
  ].join('\n\n'), 'docs/guide')
  const byText = Object.fromEntries([...root.querySelectorAll('a')].map((a) => [a.textContent, a]))
  const act = (k) => linkAction(byText[k])
  assert.deepEqual(act('a'), { kind: 'md', path: 'docs/guide/other.md', fragment: '' })
  assert.deepEqual(act('b'), { kind: 'md', path: 'docs/up.md', fragment: 'ce-md-some-heading' })
  assert.deepEqual(act('c'), { kind: 'md', path: 'rooted.md', fragment: '' })
  assert.deepEqual(act('d'), { kind: 'md', path: 'docs/guide/sub dir/x y.markdown', fragment: '' })
  assert.deepEqual(act('e'), { kind: 'external', url: 'https://example.com/p?q=1#f' })
  assert.deepEqual(act('f'), { kind: 'external', url: 'http://example.com/' })
  for (const k of ['g', 'h', 'i', 'j', 'l', 'm', 'n', 'o']) assert.deepEqual(act(k), { kind: 'none' }, k)
  assert.deepEqual(act('k'), { kind: 'anchor', id: 'ce-md-intro-section' })
  for (const a of Object.values(byText)) {
    assert.equal(a.getAttribute('href'), null, 'no href is kept: a middle click must not navigate')
    assert.equal(a.getAttribute('target'), null)
  }
})

test('openExternal: new window with noopener, http(s) only', () => {
  const calls = []
  const open = (...args) => calls.push(args)
  openExternal('https://example.com/a', open)
  openExternal('javascript:alert(1)', open)
  openExternal('file:///x', open)
  assert.deepEqual(calls, [['https://example.com/a', '_blank', 'noopener,noreferrer']])
})

test('images: relative ones are requested through the host, anything remote is a placeholder', () => {
  const { root, images } = render('![logo](img/logo.png)\n\n![up](../shared/a.png "T")\n\n![remote](https://evil.example/t.png)\n\n![proto](//evil.example/t.png)\n\n![inline](data:image/png;base64,AAAA)\n\n![esc](../../../x.png)\n\n<img src="img/logo.png" width="9999" onerror="x">', 'docs')
  assert.deepEqual(images, ['docs/img/logo.png', 'shared/a.png'])
  const imgs = [...root.querySelectorAll('img')]
  assert.equal(imgs.length, 3)
  for (const img of imgs) {
    assert.equal(img.getAttribute('src'), null, 'the src is only set by the preview from a blob URL')
    assert.ok(img.getAttribute('data-ce-img'))
    assert.equal(img.getAttribute('onerror'), null)
    assert.equal(img.getAttribute('width'), null)
  }
  const holders = [...root.querySelectorAll('[data-ce-noimg]')].map((s) => s.textContent)
  assert.deepEqual(holders, ['[image: remote]', '[image: proto]', '[image: inline]', '[image: esc]'])
  assert.match(root.querySelector('[data-ce-noimg]').title, /Remote images are not loaded/)
})

test('resolveRelative / slugify / isMarkdownPath', () => {
  assert.deepEqual(resolveRelative('a/b', '../c.md#x'), { path: 'a/c.md', fragment: 'x' })
  assert.deepEqual(resolveRelative('a', './d/./e.md?raw=1'), { path: 'a/d/e.md', fragment: '' })
  assert.equal(resolveRelative('', '../x.md'), null)
  assert.equal(resolveRelative('a', '#only'), null)
  assert.equal(resolveRelative('a', '%zz.md'), null)
  assert.equal(resolveRelative('a', 'x\\y.md'), null)
  assert.equal(resolveRelative('a', 'x\u0000.md'), null)
  assert.equal(slugify('Hello, World! 2'), 'hello-world-2')
  assert.ok(isMarkdownPath('README.MD') && isMarkdownPath('a/b.markdown') && !isMarkdownPath('a.mdx.ts'))
})

test('duplicate headings get unique ids; oversized input is cut', () => {
  const { root } = render('# A\n\n# A\n\n## A')
  assert.deepEqual([...root.querySelectorAll('h1,h2')].map((h) => h.id), ['ce-md-a', 'ce-md-a-1', 'ce-md-a-2'])
  const big = renderMarkdown(`${'x'.repeat(1_000_000)}\n\n<script>alert(1)</script>`, { docDir: '', win })
  assert.equal(big.truncated, true)
})

test('applyColorized rebuilds only text and mtk spans from the colorizer output', () => {
  const code = doc.createElement('code')
  applyColorized(code, '<span><span class="mtk1">const&nbsp;</span><span class="mtk6" onclick="x()">a</span><br/><span class="evil" style="x"><script>alert(1)</script>b</span><img src=x onerror=y></span>', doc)
  assert.equal(code.textContent, 'const a\nb')
  assert.equal(code.querySelectorAll('span').length, 2)
  assert.ok([...code.querySelectorAll('span')].every((s) => /^mtk\d+$/.test(s.className) && s.attributes.length === 1))
  assert.equal(code.querySelector('script, img'), null)
})

test('md controller: modes per tab, debounced live source, tab switches, scroll sync only side by side', async () => {
  const texts = { 'file:a.md': 'one', 'file:b.md': 'bee' }
  let active = 'file:a.md'
  const c = new MarkdownController({ getText: (id) => texts[id] ?? null, active: () => active, debounceMs: 25 })
  assert.equal(c.mode('file:a.md'), 'off')
  c.notifyEdit('file:a.md')
  await sleep(40)
  assert.equal(c.getState().source.id, null, 'nothing is rendered while the preview is off')

  c.setMode('file:a.md', 'side')
  assert.deepEqual(c.getState().source, { id: 'file:a.md', text: 'one' }, 'switching on shows the text at once')

  const seen = []
  c.subscribe(() => seen.push(c.getState().source.text))
  texts['file:a.md'] = 'one two'
  c.notifyEdit('file:a.md')
  texts['file:a.md'] = 'one two three'
  c.notifyEdit('file:a.md')
  assert.equal(c.getState().source.text, 'one', 'debounced')
  await until(() => c.getState().source.text === 'one two three', 'live update')
  assert.deepEqual(seen, ['one two three'], 'one render for a burst of edits')

  const ratios = []
  c.onScroll((r) => ratios.push(r))
  c.scrolled('file:a.md', 0.5)
  c.scrolled('file:b.md', 0.9)
  c.scrolled('file:a.md', 7)
  assert.deepEqual(ratios, [0.5, 1])
  c.setMode('file:a.md', 'only')
  c.scrolled('file:a.md', 0.2)
  assert.equal(ratios.length, 2, 'no sync when the editor is hidden')

  active = 'file:b.md'
  c.activeChanged(active)
  assert.equal(c.getState().source.id, null, 'b has no preview')
  c.setMode('file:b.md', 'only')
  assert.deepEqual(c.getState().source, { id: 'file:b.md', text: 'bee' })
  c.forget('file:b.md')
  assert.equal(c.mode('file:b.md'), 'off')
  assert.equal(c.getState().source.id, null)
  c.setMode('file:a.md', 'off')
  assert.equal(c.mode('file:a.md'), 'off')
  c.dispose()
})
