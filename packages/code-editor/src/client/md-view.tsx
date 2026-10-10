// dsh-code-editor - the markdown preview pane and its Off / Side by side / Preview mode switch.
// Logic: md-state.ts (mode, debounced source) and markdown.ts (sanitized rendering).

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { applyColorized, isMarkdownPath, linkAction, openExternal, renderMarkdown, type LinkAction } from './markdown.ts'
import type { MdMode, MdState } from './md-state.ts'
import { dirName } from './paths.ts'
import type { EditorStore, State, Tab } from './store.ts'

function useMd(store: EditorStore): MdState {
  return useSyncExternalStore(store.md.subscribe, store.md.getState, store.md.getState)
}

/** Whether a tab can be previewed. */
export const canPreview = (tab: Tab | undefined): tab is Tab => tab !== undefined && tab.kind === 'file' && isMarkdownPath(tab.path)

/** Off / Side by side / Preview switch for a markdown tab (goes into the breadcrumb row). */
export function MdModeButtons({ store, tab }: { store: EditorStore; tab: Tab }): ReactElement {
  const md = useMd(store)
  const mode: MdMode = md.modes[tab.id] ?? 'off'
  const btn = (m: MdMode, label: string, title: string): ReactElement => (
    <button className="ce-btn" data-act={`md-${m}`} data-on={mode === m} aria-pressed={mode === m} title={title} onClick={() => store.md.setMode(tab.id, m)}>{label}</button>
  )
  return (
    <span className="ce-seg" role="group" aria-label="Markdown preview">
      {btn('off', 'Editor', 'Editor only')}
      {btn('side', 'Side by side', 'Editor and live preview')}
      {btn('only', 'Preview', 'Preview only')}
    </span>
  )
}

/** Wraps the editor area: in a previewed markdown tab the preview sits next to it (or replaces it). */
export function MdWork({ store, s, tab, children }: { store: EditorStore; s: State; tab: Tab | undefined; children: ReactNode }): ReactElement {
  const md = useMd(store)
  const mode: MdMode = canPreview(tab) ? (md.modes[tab.id] ?? 'off') : 'off'
  return (
    <div className="ce-work" data-md={mode}>
      {children}
      {mode !== 'off' && canPreview(tab) ? <MarkdownPane store={store} s={s} tab={tab} source={md.source} /> : null}
    </div>
  )
}

/** Fetch each relative image through the host (blob URL); a failure leaves a text placeholder. */
async function loadImages(store: EditorStore, root: string, body: HTMLElement, urls: Map<string, Promise<string | null>>, alive: () => boolean): Promise<void> {
  const imgs = Array.from(body.querySelectorAll<HTMLImageElement>('img[data-ce-img]')).slice(0, 60)
  await Promise.all(imgs.map(async (img) => {
    const path = img.getAttribute('data-ce-img') ?? ''
    let hit = urls.get(path)
    if (!hit) {
      hit = store.deps.api.raw(root, path).then((blob) => URL.createObjectURL(blob)).catch(() => null)
      urls.set(path, hit)
    }
    const url = await hit
    if (!alive() || !img.isConnected) return
    if (url) img.src = url
    else {
      const span = document.createElement('span')
      span.setAttribute('data-ce-noimg', '')
      span.textContent = `[image: ${img.getAttribute('alt') || path}]`
      span.title = 'Image not available'
      img.replaceWith(span)
    }
  }))
}

/** Syntax-colour fenced code through the editor (Monaco's colorize) when it offers it. */
async function colorizeBlocks(store: EditorStore, body: HTMLElement, alive: () => boolean): Promise<void> {
  const host = store.getHost()
  if (!host?.colorize) return
  const blocks = Array.from(body.querySelectorAll('pre > code[class^="language-"]')).slice(0, 40)
  for (const code of blocks) {
    const lang = (code.getAttribute('class') ?? '').replace(/^language-/, '')
    const text = code.textContent ?? ''
    if (text.length > 20_000) continue
    const html = await host.colorize(text, lang)
    if (!alive()) return
    if (html !== null) applyColorized(code, html, document)
  }
}

function MarkdownPane({ store, s, tab, source }: { store: EditorStore; s: State; tab: Tab; source: MdState['source'] }): ReactElement {
  const body = useRef<HTMLDivElement | null>(null)
  const urls = useRef(new Map<string, Promise<string | null>>())
  const ready = source.id === tab.id

  // Render (the text is already debounced by the controller); the previous scroll position is kept across updates.
  useEffect(() => {
    const el = body.current
    if (!el || !ready) return
    let alive = true
    const top = el.scrollTop
    let result
    try {
      result = renderMarkdown(source.text, { docDir: dirName(tab.path) })
    } catch (e) {
      el.textContent = `Could not render: ${e instanceof Error ? e.message : String(e)}`
      return
    }
    el.replaceChildren(result.fragment)
    if (result.truncated) {
      const note = document.createElement('p')
      note.className = 'ce-md-note'
      note.textContent = 'The preview shows only the first 1,000,000 characters.'
      el.appendChild(note)
    }
    el.scrollTop = top
    if (s.root !== null) void loadImages(store, s.root, el, urls.current, () => alive)
    void colorizeBlocks(store, el, () => alive)
    return () => { alive = false }
  }, [source.text, ready, tab.path, s.root, store])

  // Blob URLs belong to this pane.
  useEffect(() => {
    const cache = urls.current
    return () => {
      for (const p of cache.values()) void p.then((u) => { if (u) URL.revokeObjectURL(u) })
      cache.clear()
    }
  }, [s.root, tab.path])

  // Scroll sync, editor -> preview, by position ratio (side by side only).
  useEffect(() => store.md.onScroll((ratio) => {
    const el = body.current
    if (el) el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight)
  }), [store])

  const act = (a: LinkAction): void => {
    if (a.kind === 'md') void store.openPreviewLink(a.path)
    else if (a.kind === 'external') openExternal(a.url)
    else if (a.kind === 'anchor') body.current?.querySelector(`[id="${a.id.replace(/["\\]/g, '')}"]`)?.scrollIntoView?.({ block: 'start' })
  }
  const target = (e: { target: EventTarget | null }): LinkAction | null => {
    const a = (e.target as HTMLElement | null)?.closest?.('a')
    return a ? linkAction(a) : null
  }
  const onClick = (e: ReactMouseEvent): void => {
    const a = target(e)
    if (a === null) return
    e.preventDefault()
    if (e.button === 0) act(a)
  }
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'Enter') return
    const a = target(e)
    if (a !== null) { e.preventDefault(); act(a) }
  }

  return (
    <div className="ce-md" data-md-pane aria-label="Markdown preview">
      <div className="ce-md-body" ref={body} onClick={onClick} onAuxClick={(e) => { if (target(e) !== null) e.preventDefault() }} onKeyDown={onKeyDown} />
      {ready ? null : <div className="ce-md-note">Loading preview...</div>}
    </div>
  )
}
