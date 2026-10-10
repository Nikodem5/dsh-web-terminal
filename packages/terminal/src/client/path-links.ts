// dsh-web-terminal — clickable file paths in a terminal.
//
// Hovering a path that exists underlines it while Ctrl (Cmd on macOS) is held; Ctrl+click opens it in
// the editor chosen in Aa. Plain clicks stay with selection and TUI mouse input. Which candidates
// exist is the host's call (`/paths`, batched and cached here); opening is the host's too (`/open`).

import type { IBuffer, IBufferRange, ILink, ILinkDecorations } from '@xterm/xterm'
import { emit, persistSoon, prefs, store } from './state.ts'
import { findPaths } from './paths.ts'
import { openInEditor } from './code-editor.ts'
import type { PathMatch } from './paths.ts'
import type { PathTarget, Runtime } from './types.ts'

const PATHS_URL = '/api/dsh-web-terminal/paths'
const OPEN_URL = '/api/dsh-web-terminal/open'
/** How long a lookup (found or not) is trusted; short, because files appear and a cwd can change. */
export const PATH_TTL_MS = 10_000
/** A failed lookup is retried after this long, so a down host is not hammered while hovering. */
const FAIL_TTL_MS = 2_000
const BATCH = 50
const CACHE_MAX = 1000
/** Lines longer than this (wrapped chains included) are not scanned. */
const MAX_LINE_CHARS = 4000
const MAX_ROWS = 40

const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
const modifierHeld = (e: { ctrlKey: boolean; metaKey: boolean }): boolean => (isMac() ? e.metaKey : e.ctrlKey)

// ── preferences ──

export function setPathTarget(target: PathTarget): void {
  prefs.pathTarget = target
  emit()
  persistSoon()
}

/** Template for the custom command, e.g. `myeditor {file}:{line}:{col}`. */
export function setPathTemplate(template: string): void {
  prefs.pathTemplate = template.slice(0, 500)
  emit()
  persistSoon()
}

// ── the terminal's text ──

export interface LogicalLine {
  text: string
  /** Per UTF-16 unit of `text`: buffer row (1-based), first and last cell column (1-based). */
  rows: number[]
  x1: number[]
  x2: number[]
}

/**
 * The text of the line at buffer row `y` (1-based) joined with the rows it wraps onto, with a map from
 * every character back to its cells (wide characters make the two differ).
 */
export function logicalLine(buffer: IBuffer, y: number, cols: number): LogicalLine {
  let top = y - 1
  for (let n = 0; top > 0 && n < MAX_ROWS && buffer.getLine(top)?.isWrapped; n++) top--
  const out: LogicalLine = { text: '', rows: [], x1: [], x2: [] }
  for (let row = top, n = 0; n < MAX_ROWS; row++, n++) {
    const line = buffer.getLine(row)
    if (line === undefined || (row > top && !line.isWrapped)) break
    const width = Math.min(line.length, cols)
    for (let x = 0; x < width; x++) {
      const cell = line.getCell(x)
      if (cell === undefined) break
      const w = cell.getWidth()
      if (w === 0) continue
      const chars = cell.getChars() || ' '
      out.text += chars
      for (let i = 0; i < chars.length; i++) {
        out.rows.push(row + 1)
        out.x1.push(x + 1)
        out.x2.push(x + w)
      }
    }
    if (out.text.length > MAX_LINE_CHARS) break
  }
  return out
}

/** Buffer range of a match inside a logical line. */
export function rangeOf(line: LogicalLine, m: PathMatch): IBufferRange {
  const last = Math.min(m.end, line.text.length) - 1
  return { start: { x: line.x1[m.start]!, y: line.rows[m.start]! }, end: { x: line.x2[last]!, y: line.rows[last]! } }
}

// ── asking the host ──

export interface Hit {
  path: string | null
  isDir: boolean
}

/** Cache + batching of `/paths` lookups for one terminal. */
export function createChecker(getContext: () => { terminalId: string; cwd: string }, now: () => number = Date.now) {
  const cache = new Map<string, Hit & { at: number; ttl: number }>()
  const inflight = new Map<string, Promise<void>>()

  const fetchBatch = async (candidates: string[]): Promise<void> => {
    const { terminalId, cwd } = getContext()
    let results: Array<{ candidate: string; path: string | null; isDir: boolean }> | undefined
    try {
      const res = await fetch(PATHS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ terminalId, cwd, candidates }),
      })
      const body = res.ok ? await res.json() : undefined
      if (Array.isArray(body?.results)) results = body.results
    } catch {}
    const at = now()
    if (cache.size > CACHE_MAX) cache.clear()
    const seen = new Set<string>()
    for (const r of results ?? []) {
      if (typeof r?.candidate !== 'string' || !candidates.includes(r.candidate)) continue
      seen.add(r.candidate)
      cache.set(r.candidate, { path: typeof r.path === 'string' ? r.path : null, isDir: r.isDir === true, at, ttl: PATH_TTL_MS })
    }
    for (const c of candidates) if (!seen.has(c)) cache.set(c, { path: null, isDir: false, at, ttl: FAIL_TTL_MS })
  }

  /** Resolve candidates (cached, negatives included); unknown ones go to the host in batches. */
  return async function check(candidates: string[]): Promise<Map<string, Hit>> {
    const t = now()
    const fresh = (c: string): boolean => {
      const e = cache.get(c)
      return e !== undefined && t - e.at < e.ttl
    }
    const unique = [...new Set(candidates)]
    const need = unique.filter((c) => !fresh(c) && !inflight.has(c))
    for (let i = 0; i < need.length; i += BATCH) {
      const batch = need.slice(i, i + BATCH)
      const p = fetchBatch(batch).finally(() => {
        for (const c of batch) inflight.delete(c)
      })
      for (const c of batch) inflight.set(c, p)
    }
    await Promise.all(unique.map((c) => inflight.get(c)))
    const hits = new Map<string, Hit>()
    for (const c of unique) {
      const e = cache.get(c)
      if (e !== undefined) hits.set(c, { path: e.path, isDir: e.isDir })
    }
    return hits
  }
}

// ── opening ──

/** A short message inside the terminal (editor missing, path gone); self-removing. */
function notify(rt: Runtime, text: string): void {
  const host = rt.term.element
  if (host === undefined) return
  const el = document.createElement('div')
  el.setAttribute('role', 'status')
  el.textContent = text
  Object.assign(el.style, {
    position: 'absolute', right: '12px', bottom: '8px', zIndex: '10', maxWidth: '70%', padding: '4px 10px', borderRadius: '6px',
    font: '12px system-ui, sans-serif', background: '#5a1d1d', color: '#fff', pointerEvents: 'none',
  })
  host.appendChild(el)
  setTimeout(() => el.remove(), 5000)
}

/**
 * Open a path with the chosen target. "Code (this app)" dispatches an in-app event (no host call); when the
 * editor plugin is not installed, or the path is a folder (nothing to show in an editor), it falls back to
 * VS Code and says so.
 */
export async function openPath(rt: Runtime, path: string, line?: number, col?: number, isDir = false): Promise<void> {
  let target: PathTarget = prefs.pathTarget
  if (target === 'code') {
    if (!isDir) {
      if (openInEditor({ path, line, col })) return
      notify(rt, 'The Code editor plugin is not installed: opening in VS Code')
    }
    target = 'vscode'
  }
  try {
    const res = await fetch(OPEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ path, line, col, target, template: prefs.pathTemplate }),
    })
    const body = await res.json().catch(() => undefined)
    if (!res.ok || body?.ok !== true) notify(rt, typeof body?.error === 'string' ? body.error : 'Could not open the file')
  } catch {
    notify(rt, 'Could not reach the host to open the file')
  }
}

// ── the xterm link provider ──

/** Register the path link provider on a terminal that has been opened. */
export function registerPathLinks(rt: Runtime): void {
  // An ssh window's paths are on the remote machine; the host would look them up on its own disk and open the wrong file.
  if (rt.ssh) return
  const term = rt.term
  const check = createChecker(() => {
    const win = store.wins.find((w) => w.id === rt.id)
    // The folder the shell reported (shell integration) beats the one it started in.
    return { terminalId: `${rt.id}-${win?.gen ?? 0}`, cwd: rt.cwd ?? win?.cwd ?? '' }
  })
  const hint = isMac() ? 'Cmd+click to open' : 'Ctrl+click to open'

  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = logicalLine(term.buffer.active, y, term.cols)
      const matches = findPaths(line.text).filter((m) => line.rows[m.start]! <= y && y <= line.rows[Math.min(m.end, line.text.length) - 1]!)
      if (matches.length === 0) return callback(undefined)
      void check(matches.map((m) => m.path)).then((hits) => {
        const links: ILink[] = []
        for (const m of matches) {
          const hit = hits.get(m.path)
          if (hit?.path == null) continue
          const resolved = hit.path
          const decorations: ILinkDecorations = { pointerCursor: false, underline: false }
          let tip: HTMLElement | undefined
          const sync = (e: { ctrlKey: boolean; metaKey: boolean }): void => {
            const on = modifierHeld(e)
            decorations.underline = on
            decorations.pointerCursor = on
          }
          // The modifier can change while the pointer rests on the link, so follow the keyboard too.
          const onKey = (e: KeyboardEvent): void => sync(e)
          links.push({
            range: rangeOf(line, m),
            text: line.text.slice(m.start, m.end),
            decorations,
            activate(event) {
              if (!modifierHeld(event)) return
              void openPath(rt, resolved, m.line, m.col, hit.isDir)
            },
            hover(event) {
              sync(event)
              window.addEventListener('keydown', onKey)
              window.addEventListener('keyup', onKey)
              const host = term.element
              if (host === undefined) return
              tip = document.createElement('div')
              tip.className = 'xterm-hover'
              tip.textContent = `${resolved}${m.line !== undefined ? `:${m.line}${m.col !== undefined ? `:${m.col}` : ''}` : ''} - ${hint}`
              const box = host.getBoundingClientRect()
              Object.assign(tip.style, {
                position: 'absolute', zIndex: '10', left: `${Math.max(0, event.clientX - box.left)}px`, top: `${Math.max(0, event.clientY - box.top + 14)}px`,
                maxWidth: '80%', padding: '2px 8px', borderRadius: '4px', font: '12px system-ui, sans-serif', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                background: '#252526', color: '#ddd', border: '1px solid #454545', pointerEvents: 'none',
              })
              host.appendChild(tip)
            },
            leave() {
              window.removeEventListener('keydown', onKey)
              window.removeEventListener('keyup', onKey)
              tip?.remove()
              tip = undefined
            },
            dispose() {
              window.removeEventListener('keydown', onKey)
              window.removeEventListener('keyup', onKey)
              tip?.remove()
            },
          })
        }
        callback(links.length > 0 ? links : undefined)
      })
    },
  })
}
