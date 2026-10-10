// dsh-code-editor - markdown to a SANITIZED DOM fragment for the preview pane.
//
// The text may come from an agent or an untrusted repository, so it is treated as hostile:
//   1. `marked` (GFM: tables, task lists, fences, strikethrough) turns it into HTML; raw HTML in the markdown passes
//      through marked, so everything below is what makes the result safe;
//   2. DOMPurify with the plain-HTML profile (no svg / mathml / forms / media / style / class / id / data-*)
//      removes scripts, event handlers, javascript: URLs and friends;
//   3. a post-pass on the sanitized DOM rewrites links and images (see `rewriteLinks` / `rewriteImages`) and sets the
//      only attributes the preview acts on (`data-ce-*`): it runs AFTER sanitizing and the sanitizer drops `data-*`,
//      so the markdown cannot forge them.
// The result is a DocumentFragment that is appended as is (never serialised and re-parsed).

import createDOMPurify from 'dompurify'
import { Marked } from 'marked'

/** Source above this many characters is cut (the preview must stay responsive). */
export const MAX_MARKDOWN_CHARS = 1_000_000

export const isMarkdownPath = (path: string): boolean => /\.(md|markdown|mdown|mkd)$/i.test(path)

export interface RenderOptions {
  /** Root-relative folder of the document ('' = the root): relative links and images resolve against it. */
  docDir: string
  /** The DOM to build in; defaults to the page's `window`. Tests pass a jsdom window. */
  win?: Window & typeof globalThis
}

export interface RenderResult {
  fragment: DocumentFragment
  /** Distinct root-relative image paths the fragment asks for (`img[data-ce-img]`); the preview fetches them. */
  images: string[]
  /** The source was longer than MAX_MARKDOWN_CHARS and got cut. */
  truncated: boolean
}

type Purify = ReturnType<typeof createDOMPurify>
const purifiers = new WeakMap<object, Purify>()

function purifierFor(win: Window & typeof globalThis): Purify {
  let p = purifiers.get(win)
  if (p) return p
  p = createDOMPurify(win as never)
  // `class` survives on <code> as language-xxx only (fences); anywhere else it could borrow the app's own styles.
  p.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'class') data.keepAttr = node.nodeName === 'CODE' && /^language-[\w#+.-]{1,30}$/.test(data.attrValue)
  })
  purifiers.set(win, p)
  return p
}

const SANITIZE = {
  USE_PROFILES: { html: true },
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: [
    'style', 'form', 'button', 'select', 'textarea', 'option', 'optgroup', 'label', 'fieldset', 'legend', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'picture', 'canvas', 'dialog', 'template', 'slot', 'marquee', 'noscript', 'script',
  ],
  FORBID_ATTR: ['style', 'id', 'name', 'form', 'formaction', 'srcset', 'sizes', 'autofocus', 'ping', 'action', 'target', 'download', 'is', 'slot', 'contenteditable', 'draggable', 'accesskey', 'tabindex'],
}

const marked = new Marked({ gfm: true, breaks: false, async: false })

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Resolve a link / image reference against the document folder: percent-decoded, `#fragment` / `?query` dropped,
 * `/x` meaning the root, `..` never leaving it. Null for anything that is not a plain path below the root.
 */
export function resolveRelative(docDir: string, ref: string): { path: string; fragment: string } | null {
  const hash = ref.indexOf('#')
  const fragment = hash >= 0 ? ref.slice(hash + 1) : ''
  let pathPart = (hash >= 0 ? ref.slice(0, hash) : ref)
  const q = pathPart.indexOf('?')
  if (q >= 0) pathPart = pathPart.slice(0, q)
  if (pathPart === '') return null
  let decoded: string
  try { decoded = decodeURIComponent(pathPart) } catch { return null }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || /^[a-zA-Z]:/.test(decoded)) return null
  const parts: string[] = decoded.startsWith('/') ? [] : docDir.split('/').filter((p) => p !== '')
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); continue }
    parts.push(seg)
  }
  return parts.length === 0 ? null : { path: parts.join('/'), fragment }
}

/** GitHub-ish heading slug (ids are prefixed `ce-md-` so they cannot collide with the page's own ids). */
export function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-')
}

function rewriteLinks(root: DocumentFragment, docDir: string): void {
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const raw = a.getAttribute('href')
    for (const attr of ['href', 'rel', 'target']) a.removeAttribute(attr)
    if (raw === null) continue
    const href = raw.trim()
    const compact = href.replace(/[\u0000- ]/g, '')
    if (href.startsWith('#')) {
      if (href.length > 1) {
        a.setAttribute('data-ce-anchor', `ce-md-${slugify(decodeSafe(href.slice(1)))}`)
        a.setAttribute('role', 'link')
        a.setAttribute('tabindex', '0')
      }
      continue
    }
    if (SCHEME.test(compact)) {
      let url: URL | null = null
      try { url = new URL(compact) } catch { url = null }
      // No href is kept: a click is handled by the preview (window.open with noopener), a middle click must not navigate.
      if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
        a.setAttribute('data-ce-ext', url.href)
        a.setAttribute('title', url.href)
        a.setAttribute('role', 'link')
        a.setAttribute('tabindex', '0')
      }
      continue // mailto:, tel:, javascript:, data:, file: ... are dropped
    }
    if (compact.startsWith('//')) continue
    const hit = resolveRelative(docDir, href)
    if (hit && isMarkdownPath(hit.path)) {
      a.setAttribute('data-ce-md', hit.path)
      a.setAttribute('role', 'link')
      a.setAttribute('tabindex', '0')
      a.setAttribute('title', hit.path)
      if (hit.fragment) a.setAttribute('data-ce-frag', `ce-md-${slugify(decodeSafe(hit.fragment))}`)
    }
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** Relative images become `img[data-ce-img]` (fetched through the host); everything else is replaced by a text placeholder. */
function rewriteImages(root: DocumentFragment, docDir: string, doc: Document): string[] {
  const wanted = new Set<string>()
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = (img.getAttribute('src') ?? '').trim()
    const alt = (img.getAttribute('alt') ?? '').slice(0, 200)
    const hit = src !== '' && !SCHEME.test(src.replace(/[\u0000- ]/g, '')) && !src.startsWith('//') ? resolveRelative(docDir, src) : null
    if (hit) {
      for (const attr of Array.from(img.attributes)) if (attr.name !== 'alt' && attr.name !== 'title') img.removeAttribute(attr.name)
      img.setAttribute('data-ce-img', hit.path)
      img.setAttribute('alt', alt)
      wanted.add(hit.path)
      continue
    }
    const span = doc.createElement('span')
    span.setAttribute('data-ce-noimg', '')
    span.textContent = alt !== '' ? `[image: ${alt}]` : '[image]'
    span.title = /^https?:/i.test(src) || src.startsWith('//') ? 'Remote images are not loaded in the preview' : 'Image not available'
    img.replaceWith(span)
  }
  return [...wanted]
}

function lockInputs(root: DocumentFragment): void {
  for (const input of Array.from(root.querySelectorAll('input'))) {
    if ((input.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') { input.remove(); continue }
    for (const attr of Array.from(input.attributes)) if (attr.name !== 'checked') input.removeAttribute(attr.name)
    input.setAttribute('type', 'checkbox')
    input.setAttribute('disabled', '')
  }
}

function addHeadingIds(root: DocumentFragment): void {
  const used = new Map<string, number>()
  for (const h of Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    const base = slugify(h.textContent ?? '')
    if (base === '') continue
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    h.setAttribute('id', `ce-md-${n === 0 ? base : `${base}-${n}`}`)
  }
}

/** Markdown to a sanitized fragment. */
export function renderMarkdown(source: string, opts: RenderOptions): RenderResult {
  const win = opts.win ?? (globalThis as unknown as { window?: Window & typeof globalThis }).window
  if (!win) throw new Error('renderMarkdown needs a DOM')
  const truncated = source.length > MAX_MARKDOWN_CHARS
  const html = marked.parse(truncated ? source.slice(0, MAX_MARKDOWN_CHARS) : source) as string
  const fragment = purifierFor(win).sanitize(html, SANITIZE as never) as unknown as DocumentFragment
  rewriteLinks(fragment, opts.docDir)
  const images = rewriteImages(fragment, opts.docDir, win.document)
  lockInputs(fragment)
  addHeadingIds(fragment)
  return { fragment, images, truncated }
}

/**
 * Put Monaco's `colorize` output into a `<code>` element WITHOUT trusting it: the HTML is parsed inertly, and only
 * text, `<br>` (a newline) and `<span class="mtk...">` are rebuilt with DOM calls.
 */
export function applyColorized(code: Element, html: string, doc: Document): void {
  const template = doc.createElement('template')
  template.innerHTML = html
  const out = doc.createDocumentFragment()
  const walk = (from: Node, into: Node): void => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === 3) into.appendChild(doc.createTextNode((node.textContent ?? '').replace(/\u00a0/g, ' ')))
      else if (node.nodeName === 'BR') into.appendChild(doc.createTextNode('\n'))
      else if (node.nodeName === 'SPAN') {
        const cls = (node as Element).getAttribute('class') ?? ''
        if (/^mtk\d+(?: mtk[a-z]+)*$/.test(cls)) {
          const span = doc.createElement('span')
          span.className = cls
          walk(node, span)
          into.appendChild(span)
        } else walk(node, into)
      }
    }
  }
  walk(template.content, out)
  code.replaceChildren(out)
}

/** What a click on (or inside) a rendered link asks for. */
export type LinkAction =
  | { kind: 'md'; path: string; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'none' }

/** The action for a link element of a rendered fragment (reads only the `data-ce-*` attributes set by renderMarkdown). */
export function linkAction(a: { getAttribute(name: string): string | null }): LinkAction {
  const md = a.getAttribute('data-ce-md')
  if (md) return { kind: 'md', path: md, fragment: a.getAttribute('data-ce-frag') ?? '' }
  const ext = a.getAttribute('data-ce-ext')
  if (ext && /^https?:\/\//i.test(ext)) return { kind: 'external', url: ext }
  const anchor = a.getAttribute('data-ce-anchor')
  if (anchor) return { kind: 'anchor', id: anchor }
  return { kind: 'none' }
}

/** Open an external link the way the preview does: new window, no opener, no referrer. */
export function openExternal(url: string, open: (url: string, target: string, features: string) => unknown = (u, t, f) => window.open(u, t, f)): void {
  if (!/^https?:\/\//i.test(url)) return
  open(url, '_blank', 'noopener,noreferrer')
}
