// dsh-code-editor - the SEARCH sidebar view's logic: query + toggles, debounced runs that cancel stale requests,
// grouped results, collapsing and keyboard stepping. No DOM and no store import: the page's store hands in `Deps`.

import type { Api } from './api.ts'
import type { SearchFile, SearchMatch, SearchQuery } from './types.ts'

export const SEARCH_DEBOUNCE_MS = 300

export interface SearchState {
  /** Which sidebar view is shown. */
  view: 'files' | 'search'
  query: SearchQuery
  /** The include / exclude fields are expanded. */
  showFilters: boolean
  status: 'idle' | 'loading' | 'done' | 'error'
  error: string | null
  results: SearchFile[]
  /** Total matches in `results`. */
  total: number
  truncated: boolean
  timedOut: boolean
  took: number
  /** File paths whose group is collapsed. */
  collapsed: string[]
  /** The highlighted match (keyboard / last opened). */
  sel: { path: string; index: number } | null
  /** Bumped to ask the view to focus (and select) the query input. */
  focus: number
}

export interface SearchDeps {
  api: Pick<Api, 'search'>
  /** The root searched; null = none selected. */
  root(): string | null
  /** Open `path` at the match (the page's store opens the tab, reveals and highlights). */
  open(path: string, match: SearchMatch): Promise<void>
  /** Drop the highlight the last `open` left in the editor. */
  clearHighlight?(): void
  debounceMs?: number
}

export const emptyQuery = (): SearchQuery => ({ q: '', regex: false, caseSensitive: false, word: false, include: '', exclude: '' })

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const countMatches = (files: SearchFile[]): number => files.reduce((n, f) => n + f.matches.length, 0)

/** The preview split around the match, for highlighting. */
export function splitPreview(m: SearchMatch): { before: string; hit: string; after: string } {
  const at = typeof m.at === 'number' && m.at >= 0 && m.at <= m.preview.length ? m.at : 0
  return { before: m.preview.slice(0, at), hit: m.preview.slice(at, at + m.length), after: m.preview.slice(at + m.length) }
}

export class SearchController {
  private s: SearchState
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private generation = 0
  /** The query the shown results belong to (Enter reruns only when the text changed since). */
  private ranFor: string | null = null
  private readonly deps: SearchDeps

  constructor(deps: SearchDeps) {
    this.deps = deps
    this.s = {
      view: 'files', query: emptyQuery(), showFilters: false, status: 'idle', error: null, results: [], total: 0, truncated: false, timedOut: false, took: 0,
      collapsed: [], sel: null, focus: 0,
    }
  }

  getState = (): SearchState => this.s
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  private set(patch: Partial<SearchState>): void {
    this.s = { ...this.s, ...patch }
    for (const l of [...this.listeners]) l()
  }

  // ---- view ---------------------------------------------------------------------------------------------------

  /** Show the SEARCH view and focus its input (Ctrl+Shift+F). */
  show(): void { this.set({ view: 'search', focus: this.s.focus + 1 }) }
  /** Back to the file tree. */
  showFiles(): void { this.set({ view: 'files' }) }
  toggleFilters(): void { this.set({ showFilters: !this.s.showFilters }) }

  // ---- query --------------------------------------------------------------------------------------------------

  /** Typing in the query / include / exclude fields: debounced run. */
  setText(patch: Partial<Pick<SearchQuery, 'q' | 'include' | 'exclude'>>): void {
    this.set({ query: { ...this.s.query, ...patch } })
    this.schedule()
  }

  /** The match-case / whole-word / regex buttons: run right away. */
  setFlag(flag: 'regex' | 'caseSensitive' | 'word', on: boolean): void {
    this.set({ query: { ...this.s.query, [flag]: on } })
    this.cancelTimer()
    void this.run()
  }

  private cancelTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private schedule(): void {
    this.cancelTimer()
    if (this.s.query.q.trim() === '') { void this.run(); return }
    this.timer = setTimeout(() => { this.timer = null; void this.run() }, this.deps.debounceMs ?? SEARCH_DEBOUNCE_MS)
  }

  /** Cancel whatever is pending or in flight. */
  cancel(): void {
    this.cancelTimer()
    this.abort?.abort()
    this.abort = null
    this.generation++
  }

  /** Run the search now; an older request that is still in flight is aborted and its answer ignored. */
  async run(): Promise<void> {
    this.cancelTimer()
    this.abort?.abort()
    this.abort = null
    const gen = ++this.generation
    const query = this.s.query
    const root = this.deps.root()
    if (query.q === '' || root === null) {
      this.ranFor = null
      this.deps.clearHighlight?.()
      this.set({ status: 'idle', error: null, results: [], total: 0, truncated: false, timedOut: false, took: 0, collapsed: [], sel: null })
      return
    }
    const ac = new AbortController()
    this.abort = ac
    this.set({ status: 'loading', error: null })
    try {
      const r = await this.deps.api.search(root, query, ac.signal)
      if (gen !== this.generation) return
      this.abort = null
      this.ranFor = JSON.stringify(query)
      this.set({ status: 'done', error: null, results: r.results, total: countMatches(r.results), truncated: r.truncated, timedOut: r.timedOut === true, took: r.took, collapsed: [], sel: null })
    } catch (e) {
      if (gen !== this.generation) return
      this.abort = null
      this.set({ status: 'error', error: errText(e), results: [], total: 0, truncated: false, timedOut: false, sel: null })
    }
  }

  /** Enter in the input: open the selected match when the results are current, else search now. */
  async enter(): Promise<void> {
    if (this.s.sel && this.ranFor === JSON.stringify(this.s.query) && this.s.status === 'done') await this.openSelected()
    else await this.run()
  }

  /** The root changed: results of the old root are meaningless. */
  reset(): void {
    this.cancel()
    this.ranFor = null
    this.set({ status: 'idle', error: null, results: [], total: 0, truncated: false, timedOut: false, took: 0, collapsed: [], sel: null })
  }

  // ---- results ------------------------------------------------------------------------------------------------

  toggleFile(path: string): void {
    const has = this.s.collapsed.includes(path)
    this.set({ collapsed: has ? this.s.collapsed.filter((p) => p !== path) : [...this.s.collapsed, path] })
  }

  /** Every match that is currently visible (its file group not collapsed), in display order. */
  visible(): Array<{ path: string; index: number; match: SearchMatch }> {
    const out: Array<{ path: string; index: number; match: SearchMatch }> = []
    for (const f of this.s.results) {
      if (this.s.collapsed.includes(f.path)) continue
      f.matches.forEach((match, index) => out.push({ path: f.path, index, match }))
    }
    return out
  }

  select(path: string, index: number): void { this.set({ sel: { path, index } }) }

  /** Move the selection by `dir` (wrapping); `open` also opens the new match in the editor. */
  async step(dir: 1 | -1, open: boolean): Promise<void> {
    const list = this.visible()
    if (list.length === 0) return
    const cur = this.s.sel ? list.findIndex((x) => x.path === this.s.sel?.path && x.index === this.s.sel?.index) : -1
    const next = cur < 0 ? (dir === 1 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length
    this.select(list[next].path, list[next].index)
    if (open) await this.openSelected()
  }

  async openSelected(): Promise<void> {
    const sel = this.s.sel
    if (!sel) return
    const match = this.s.results.find((f) => f.path === sel.path)?.matches[sel.index]
    if (match) await this.deps.open(sel.path, match)
  }

  /** Click on a match. */
  async openMatch(path: string, index: number): Promise<void> {
    this.select(path, index)
    await this.openSelected()
  }

  dispose(): void { this.cancel(); this.listeners.clear() }
}
