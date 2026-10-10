// dsh-code-editor - the page logic: roots, explorer, tabs (dirty / conflict state machine), git changes,
// live updates, persistence and the cross-plugin open request. No DOM and no Monaco: the editor is an
// `EditorHost` handed in through `attachHost`, the host through `Api`, so all of this is unit-testable.

import type { EditorHost, AdapterFactory } from './adapter.ts'
import { ApiError, type Api } from './api.ts'
import { groupChanges, planDiscard } from './changes.ts'
import { baseName, dirName, findRoot, joinRel, languageFor, normKey, relativeTo, sameRoot } from './paths.ts'
import { DEFAULT_LAYOUT, defaultStorage, loadGlobal, loadRootState, sanitizeLayout, saveGlobal, saveRootState, type Layout, type StorageLike } from './persist.ts'
import type { GitFile, GitStatus, OpenRequest, RepoEntry, RepoList, RootInfo, TreeEntry, WsFrame } from './types.ts'
import { openLive, type LiveState, type SocketCtor } from './ws.ts'

export interface GitState { status: GitStatus | null; notGit: boolean; error: string | null; loading: boolean }
/** The repositories of the CHANGES view; `list === null` until the first discovery finished. */
export interface RepoState { list: RepoEntry[] | null; loading: boolean; truncated: boolean; error: string | null }

export interface TreeNode { entries: TreeEntry[] | null; loading: boolean; error: string | null }

export interface Tab {
  id: string
  kind: 'file' | 'diff' | 'compare'
  path: string
  /** Diff tabs: the staged (HEAD vs index) or unstaged (index vs work tree) side. */
  staged: boolean
  /** Diff tabs: root-relative folder of the repository the diff belongs to ('' = the root itself). `path` stays root-relative. */
  repo: string
  title: string
  language: string
  loaded: boolean
  loading: boolean
  error: string | null
  /** File tabs: mtime of the version the buffer was loaded from / last saved as. */
  mtime: number | null
  /** File tabs: text as last loaded or saved (the dirty baseline). */
  saved: string
  /** File tabs: loaded text waiting for its editor model to be created. */
  initial: string | null
  dirty: boolean
  eol: 'lf' | 'crlf'
  binary: boolean
  tooLarge: boolean
  /** The file changed on disk under unsaved edits (or was deleted). */
  conflict: { mtime: number | null; deleted: boolean } | null
  saving: boolean
  /** Diff / compare tabs: the two sides. */
  diff: { original: string; modified: string } | null
  /** Compare tabs: the file tab this compares and the disk mtime captured. */
  of: string | null
  diskMtime: number | null
}

export type Notice = { text: string; level: 'info' | 'error' }

export interface State {
  workspaces: string[]
  roots: RootInfo[]
  root: string | null
  tree: Record<string, TreeNode>
  expanded: string[]
  /** Status of the root's own repository (the root is inside a work tree). */
  git: GitState
  /** Discovered repositories (root inside a repo: that one; else the ones nested below it). */
  repos: RepoState
  /** Status per nested repository, keyed by `RepoEntry.rel` (only when the root is not itself in a work tree). */
  repoGit: Record<string, GitState>
  /** Folders the user opened by hand (kept in the folder list even when nested in a workspace). */
  folders: string[]
  layout: Layout
  tabs: Tab[]
  active: string | null
  inline: boolean
  cursor: { line: number; col: number } | null
  live: LiveState
  quickOpen: boolean
  /** Bumped by a review request: the page expands the CHANGES section. */
  changesFocus: number
  notice: Notice | null
  hostReady: boolean
  /** Recently opened file paths (newest first), for the empty quick-open list. */
  recent: string[]
}

export interface Deps {
  api: Api
  storage?: StorageLike | null
  confirm?(message: string): boolean
  /** Lazily loads the editor (Monaco). Absent in tests that never attach a host. */
  loadAdapter?: () => Promise<AdapterFactory>
  isDark?: () => boolean
  Socket?: SocketCtor
  /** Switch the harness to the Code page (best effort). */
  selectPanel?: () => void
  /** Native folder chooser (the desktop app's `__DSH_DIRECTORY_PICKER__`); absent = typed path only. */
  picker?: { available(): boolean; pick(): Promise<string | null> }
  /** Coalescing delay for git refreshes after a `changed` frame, ms. */
  gitDelayMs?: number
  /** Reconnect delay override (tests). */
  wsDelay?: (n: number) => number
}

const fileId = (path: string): string => `file:${path}`
const diffId = (path: string, staged: boolean): string => `diff:${staged ? 's' : 'w'}:${path}`
const compareId = (path: string): string => `cmp:${path}`
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const blankTab = (id: string, kind: Tab['kind'], path: string, staged = false, repo = ''): Tab => ({
  id, kind, path, staged, repo, title: baseName(path), language: languageFor(path), loaded: false, loading: false, error: null, mtime: null, saved: '', initial: null,
  dirty: false, eol: 'lf', binary: false, tooLarge: false, conflict: null, saving: false, diff: null, of: null, diskMtime: null,
})

export class EditorStore {
  private s: State
  private listeners = new Set<() => void>()
  private host: EditorHost | null = null
  private hostLoading: Promise<void> | null = null
  private live: { close(): void } | null = null
  private filesCache: { root: string; files: string[]; truncated: boolean } | null = null
  private filesStale = true
  private gitInflight: Promise<void> | null = null
  private gitAgain = false
  private gitFresh = false
  private gitTimer: ReturnType<typeof setTimeout> | null = null
  private pendingReveal: { id: string; line: number; col: number } | null = null
  private generation = 0
  private storage: StorageLike | null
  private folders: string[]
  readonly deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage
    const g = loadGlobal(this.storage)
    this.folders = g.folders
    this.s = {
      workspaces: [], roots: [], root: null, tree: {}, expanded: [], git: { status: null, notGit: false, error: null, loading: false },
      repos: { list: null, loading: false, truncated: false, error: null }, repoGit: {}, folders: g.folders, layout: g.layout ?? DEFAULT_LAYOUT,
      tabs: [], active: null, inline: false, cursor: null, live: 'down', quickOpen: false, changesFocus: 0, notice: null, hostReady: false, recent: [],
    }
  }

  // ---- store plumbing -------------------------------------------------------------------------------------------

  getState = (): State => this.s
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  private set(patch: Partial<State>): void {
    this.s = { ...this.s, ...patch }
    for (const l of [...this.listeners]) l()
  }
  private patchTab(id: string, patch: Partial<Tab>): void {
    this.set({ tabs: this.s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
  }
  tab(id: string | null): Tab | undefined { return id === null ? undefined : this.s.tabs.find((t) => t.id === id) }
  get activeTab(): Tab | undefined { return this.tab(this.s.active) }
  notify(text: string, level: Notice['level'] = 'error'): void { this.set({ notice: { text, level } }) }
  dismissNotice(): void { if (this.s.notice) this.set({ notice: null }) }
  private confirm(msg: string): boolean { return this.deps.confirm ? this.deps.confirm(msg) : true }
  private get dark(): boolean { return this.deps.isDark ? this.deps.isDark() : true }

  // ---- roots ------------------------------------------------------------------------------------------------------

  /** Every folder the UI knows about (workspaces + picked folders + whatever the host accepted). */
  knownRoots(): string[] {
    const out: string[] = []
    for (const p of [...this.s.workspaces, ...this.folders, ...this.s.roots.map((r) => r.path)]) if (!out.some((o) => sameRoot(o, p))) out.push(p)
    return out
  }

  private mergeRoots(infos: RootInfo[]): void {
    const roots = [...this.s.roots]
    for (const r of infos) {
      const i = roots.findIndex((x) => sameRoot(x.path, r.path))
      if (i >= 0) roots[i] = r
      else roots.push(r)
    }
    this.set({ roots })
  }

  private async register(paths: string[]): Promise<RootInfo[]> {
    if (paths.length === 0) return []
    const { roots, rejected } = await this.deps.api.roots(paths)
    this.mergeRoots(roots)
    if (rejected.length > 0) this.notify(`Folder not accepted: ${rejected.map((r) => `${r.path} (${r.reason})`).join('; ')}`)
    // The host answers with its whole registered union: report just the entries that were asked for.
    return roots.filter((r) => paths.some((p) => sameRoot(p, r.path)))
  }

  /** Called by the page with the harness Workspaces; registers them and picks a root when none is selected. */
  async setWorkspaces(paths: string[]): Promise<void> {
    const clean = paths.filter((p) => typeof p === 'string' && p.length > 0)
    const same = clean.length === this.s.workspaces.length && clean.every((p, i) => p === this.s.workspaces[i])
    if (same && this.s.roots.length > 0) return
    this.set({ workspaces: clean })
    try { await this.register([...clean, ...this.folders]) } catch (e) { this.notify(`Could not register folders: ${errText(e)}`) }
    if (this.s.root === null) {
      const last = loadGlobal(this.storage).lastRoot
      const ok = (p: string | null): p is string => p !== null && this.s.roots.some((r) => r.exists && sameRoot(r.path, p))
      const pick = ok(last) ? last : clean.find((p) => ok(p)) ?? this.s.roots.find((r) => r.exists)?.path ?? null
      if (pick !== null) await this.selectRoot(this.s.roots.find((r) => sameRoot(r.path, pick))?.path ?? pick)
    }
  }

  /** "Open folder...": register an absolute path the user typed and switch to it. */
  async openFolder(path: string): Promise<boolean> {
    const p = path.trim().replace(/^"(.*)"$/, '$1')
    if (p.length === 0) return false
    try {
      const infos = await this.register([p])
      const info = infos.find((r) => sameRoot(r.path, p)) ?? infos[0]
      if (!info || !info.exists) { this.notify(`Folder not found: ${p}`); return false }
      if (!this.folders.some((f) => sameRoot(f, info.path)) && !this.s.workspaces.some((w) => sameRoot(w, info.path))) {
        this.folders = [info.path, ...this.folders].slice(0, 30)
        this.set({ folders: this.folders })
        this.saveG(this.s.root)
      }
      return await this.selectRoot(info.path)
    } catch (e) {
      this.notify(`Could not open folder: ${errText(e)}`)
      return false
    }
  }

  /** Persist the global part (last root, picked folders, sidebar layout). */
  private saveG(lastRoot: string | null): void {
    saveGlobal(this.storage, { lastRoot, folders: this.folders, layout: this.s.layout })
  }

  /** The desktop app offers a native folder chooser. */
  canBrowse(): boolean { return this.deps.picker?.available() === true }

  /** "Browse...": ask the OS for a folder, then register + select it like a typed path. False when cancelled. */
  async browse(): Promise<boolean> {
    const picker = this.deps.picker
    if (!picker || !picker.available()) return false
    let picked: string | null = null
    try { picked = await picker.pick() } catch { picked = null }
    if (typeof picked !== 'string' || picked.trim().length === 0) return false
    return this.openFolder(picked)
  }

  // ---- layout -----------------------------------------------------------------------------------------------------

  /** Change the sidebar geometry / section state (clamped) and remember it. */
  setLayout(patch: Partial<Layout>): void {
    const layout = sanitizeLayout({ ...this.s.layout, ...patch })
    const a = this.s.layout
    if (a.sidebar === layout.sidebar && a.exFrac === layout.exFrac && a.exOpen === layout.exOpen && a.chOpen === layout.chOpen) return
    this.set({ layout })
    this.saveG(this.s.root)
  }

  /** Switch the explorer / changes / tabs to another registered root. False when the user cancelled (unsaved edits). */
  async selectRoot(root: string): Promise<boolean> {
    if (this.s.root !== null && sameRoot(this.s.root, root)) return true
    const dirty = this.s.tabs.filter((t) => t.dirty)
    if (dirty.length > 0 && !this.confirm(`${dirty.length} file(s) have unsaved changes (${dirty.map((t) => t.title).join(', ')}). Switch folder and discard them?`)) return false
    this.persistRoot()
    this.closeLive()
    for (const t of this.s.tabs) this.host?.disposeModel(t.id)
    const gen = ++this.generation
    const st = loadRootState(this.storage, root)
    this.filesCache = null
    this.filesStale = true
    this.set({
      root, tree: {}, expanded: st.expanded, tabs: [], active: null, inline: st.inline, cursor: null, quickOpen: false, notice: null,
      git: { status: null, notGit: false, error: null, loading: false }, repos: { list: null, loading: false, truncated: false, error: null }, repoGit: {}, recent: [],
    })
    this.host?.showNone()
    this.saveG(root)
    this.openLiveSocket(root)
    void this.loadDir('')
    for (const d of st.expanded) void this.loadDir(d)
    void this.refreshGit()
    // Restore tabs (the active one loads first; the rest load when activated).
    for (const t of st.tabs) this.addTab(t.kind === 'diff' ? blankTab(diffId(t.path, t.staged === true), 'diff', t.path, t.staged === true, t.repo ?? '') : blankTab(fileId(t.path), 'file', t.path))
    const want = st.active !== null && this.tab(st.active) ? st.active : this.s.tabs[0]?.id ?? null
    if (gen === this.generation && want !== null) await this.activate(want)
    return true
  }

  private addTab(tab: Tab): void {
    if (!this.tab(tab.id)) this.set({ tabs: [...this.s.tabs, tab] })
  }

  private persistRoot(): void {
    const root = this.s.root
    if (root === null) return
    saveRootState(this.storage, root, {
      tabs: this.s.tabs.filter((t) => t.kind !== 'compare').map((t) => (t.kind === 'diff' ? { kind: 'diff' as const, path: t.path, staged: t.staged, repo: t.repo } : { kind: 'file' as const, path: t.path })),
      active: this.tab(this.s.active)?.kind === 'compare' ? null : this.s.active,
      expanded: this.s.expanded,
      inline: this.s.inline,
    })
  }

  // ---- explorer -------------------------------------------------------------------------------------------------

  async loadDir(dir: string, silent = false): Promise<void> {
    const root = this.s.root
    if (root === null) return
    const prev = this.s.tree[dir]
    if (!silent) this.set({ tree: { ...this.s.tree, [dir]: { entries: prev?.entries ?? null, loading: true, error: null } } })
    try {
      const entries = await this.deps.api.tree(root, dir)
      if (this.s.root !== root) return
      this.set({ tree: { ...this.s.tree, [dir]: { entries, loading: false, error: null } } })
    } catch (e) {
      if (this.s.root !== root) return
      this.set({ tree: { ...this.s.tree, [dir]: { entries: prev?.entries ?? null, loading: false, error: errText(e) } } })
    }
  }

  async toggleDir(dir: string): Promise<void> {
    const open = this.s.expanded.includes(dir)
    this.set({ expanded: open ? this.s.expanded.filter((d) => d !== dir) : [...this.s.expanded, dir] })
    this.persistRoot()
    if (!open && !this.s.tree[dir]?.entries) await this.loadDir(dir)
  }

  /** Expand every ancestor of `rel` (reveal in explorer). */
  async reveal(rel: string): Promise<void> {
    const parts = rel.split('/').slice(0, -1)
    let cur = ''
    const todo: string[] = []
    for (const p of parts) {
      cur = joinRel(cur, p)
      if (!this.s.expanded.includes(cur)) todo.push(cur)
    }
    if (todo.length === 0) return
    this.set({ expanded: [...this.s.expanded, ...todo] })
    this.persistRoot()
    await Promise.all(todo.filter((d) => !this.s.tree[d]?.entries).map((d) => this.loadDir(d)))
  }

  async refreshExplorer(): Promise<void> {
    await Promise.all(['', ...this.s.expanded].map((d) => this.loadDir(d, true)))
  }

  // ---- quick open -----------------------------------------------------------------------------------------------

  setQuickOpen(open: boolean): void { if (this.s.quickOpen !== open) this.set({ quickOpen: open }) }

  async ensureFiles(): Promise<string[]> {
    const root = this.s.root
    if (root === null) return []
    if (this.filesCache && this.filesCache.root === root && !this.filesStale) return this.filesCache.files
    try {
      const r = await this.deps.api.files(root)
      if (this.s.root !== root) return []
      this.filesCache = { root, files: r.files, truncated: r.truncated }
      this.filesStale = false
      return r.files
    } catch (e) {
      this.notify(`Could not list files: ${errText(e)}`)
      return this.filesCache?.files ?? []
    }
  }
  get filesTruncated(): boolean { return this.filesCache?.truncated === true }

  // ---- tabs --------------------------------------------------------------------------------------------------------

  async openFile(path: string, opts: { line?: number; col?: number; activate?: boolean } = {}): Promise<void> {
    const id = fileId(path)
    this.addTab(blankTab(id, 'file', path))
    this.set({ recent: [path, ...this.s.recent.filter((p) => p !== path)].slice(0, 20) })
    if (opts.line !== undefined) this.pendingReveal = { id, line: opts.line, col: opts.col ?? 1 }
    if (opts.activate !== false) await this.activate(id)
    else await this.ensureLoaded(id)
    void this.reveal(path)
  }

  /** Open the diff of a changed file. `path` is relative to the root; `repo` is the root-relative folder of its repository. */
  async openDiff(path: string, staged: boolean, repo = ''): Promise<void> {
    const id = diffId(path, staged)
    this.addTab(blankTab(id, 'diff', path, staged, repo))
    this.patchTab(id, { title: `${baseName(path)} (${staged ? 'staged' : 'changes'})` })
    await this.activate(id)
  }

  async activate(id: string): Promise<void> {
    if (!this.tab(id)) return
    this.set({ active: id })
    this.persistRoot()
    await this.ensureLoaded(id)
    if (this.s.active === id) this.syncEditor()
  }

  private async ensureLoaded(id: string): Promise<void> {
    const t = this.tab(id)
    if (!t || t.loaded || t.loading || t.kind === 'compare') return
    if (t.kind === 'file') await this.loadFileTab(id)
    else await this.loadDiffTab(id)
  }

  private async loadFileTab(id: string): Promise<void> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t) return
    this.patchTab(id, { loading: true, error: null })
    try {
      const r = await this.deps.api.readFile(root, t.path)
      if (this.s.root !== root || !this.tab(id)) return
      const text = r.binary || r.tooLarge || r.content === null ? null : r.content
      this.patchTab(id, { loading: false, loaded: true, mtime: r.mtime, eol: r.eol === 'crlf' ? 'crlf' : 'lf', binary: r.binary, tooLarge: r.tooLarge, initial: text, saved: text ?? '', dirty: false, conflict: null })
    } catch (e) {
      if (this.s.root !== root || !this.tab(id)) return
      this.patchTab(id, { loading: false, error: errText(e) })
    }
  }

  private async loadDiffTab(id: string): Promise<void> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t) return
    this.patchTab(id, { loading: true, error: null })
    try {
      if (t.repo !== '' && this.s.repos.list === null) await this.refreshGit()
      const where = this.diffTarget(t)
      if (where === null) throw new Error('This repository is no longer part of the folder.')
      const r = await this.deps.api.gitDiff(where.root, where.path, t.staged)
      if (this.s.root !== root || !this.tab(id)) return
      const skip = r.binary || r.tooLarge
      this.patchTab(id, { loading: false, loaded: true, binary: r.binary, tooLarge: r.tooLarge, diff: skip ? null : { original: r.original ?? '', modified: r.modified ?? '' } })
    } catch (e) {
      if (this.s.root !== root || !this.tab(id)) return
      this.patchTab(id, { loading: false, error: errText(e) })
    }
  }

  /** The git root and repo-relative path a diff tab asks the host for. */
  private diffTarget(t: Tab): { root: string; path: string } | null {
    const root = this.s.root
    if (root === null) return null
    if (t.repo === '') return { root, path: t.path }
    const repo = this.repoPath(t.repo)
    return repo === null ? null : { root: repo, path: t.path.slice(t.repo.length + 1) }
  }

  /** Push the active tab to the editor. */
  syncEditor(): void {
    const host = this.host
    if (!host) return
    const t = this.activeTab
    if (!t || !t.loaded || t.binary || t.tooLarge || t.error) { host.showNone(); return }
    host.setInline(this.s.inline)
    if (t.kind === 'file') {
      if (!host.hasModel(t.id) && t.initial !== null) {
        const text = host.showFile(t.id, t.initial, t.language, false)
        this.patchTab(t.id, { initial: null, saved: text, dirty: false, eol: host.getEol(t.id) })
      } else {
        host.showFile(t.id, '', t.language, false)
        const v = host.getValue(t.id)
        if (v !== null && t.eol !== host.getEol(t.id)) this.patchTab(t.id, { eol: host.getEol(t.id) })
      }
    } else if (t.diff) {
      host.showDiff(t.id, t.diff.original, t.diff.modified, t.language, this.s.inline)
    }
    const pr = this.pendingReveal
    if (pr && pr.id === t.id) { host.reveal(pr.line, pr.col); this.pendingReveal = null }
  }

  /** Close a tab; a dirty one asks first unless `force`. False when the user said no. */
  closeTab(id: string, force = false): boolean {
    const t = this.tab(id)
    if (!t) return true
    if (t.dirty && !force && !this.confirm(`"${t.title}" has unsaved changes. Close it and discard them?`)) return false
    const idx = this.s.tabs.findIndex((x) => x.id === id)
    const tabs = this.s.tabs.filter((x) => x.id !== id)
    this.host?.disposeModel(id)
    let active = this.s.active
    if (active === id) active = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null
    this.set({ tabs, active })
    this.persistRoot()
    if (active !== null && active !== id) void this.activate(active)
    else this.host?.showNone()
    return true
  }

  closeActive(): void { if (this.s.active !== null) this.closeTab(this.s.active) }

  setInline(inline: boolean): void {
    this.set({ inline })
    this.host?.setInline(inline)
    this.persistRoot()
    if (this.activeTab && this.activeTab.kind !== 'file') this.syncEditor()
  }

  // ---- editor events --------------------------------------------------------------------------------------------

  /** Wire the editor into the page and show the active tab. */
  attachHost(host: EditorHost): void {
    this.host = host
    host.onChange((id) => {
      const t = this.tab(id)
      if (!t || t.kind !== 'file') return
      const v = host.getValue(id)
      if (v === null) return
      const dirty = v !== t.saved
      if (dirty !== t.dirty) this.patchTab(id, { dirty })
    })
    host.onCursor((p) => {
      const c = this.s.cursor
      if (!c || c.line !== p.line || c.col !== p.col) this.set({ cursor: p })
    })
    host.onKey((a) => {
      if (a === 'save') void this.save()
      else if (a === 'quickOpen') this.setQuickOpen(!this.s.quickOpen)
      else this.closeActive()
    })
    this.set({ hostReady: true })
    this.syncEditor()
  }

  /** Load the editor lazily (first time the page opens). Failure leaves the page usable without an editor. */
  ensureHost(): Promise<void> {
    if (this.host) return Promise.resolve()
    if (this.hostLoading) return this.hostLoading
    const load = this.deps.loadAdapter
    if (!load) return Promise.resolve()
    this.hostLoading = (async () => {
      try {
        const factory = await load()
        const host = await factory.create({ dark: this.dark })
        this.attachHost(host)
      } catch (e) {
        this.notify(`The editor could not start: ${errText(e)}`)
      } finally {
        this.hostLoading = null
      }
    })()
    return this.hostLoading
  }

  getHost(): EditorHost | null { return this.host }

  setDark(dark: boolean): void { this.host?.setTheme(dark) }

  // ---- saving and conflicts -------------------------------------------------------------------------------------

  async save(id: string | null = this.s.active): Promise<boolean> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t || t.kind !== 'file' || !t.loaded || t.binary || t.tooLarge || t.saving) return false
    const content = this.host?.getValue(t.id)
    if (content === null || content === undefined) return false
    return this.write(t.id, content, t.mtime)
  }

  private async write(id: string, content: string, expectedMtime: number | null): Promise<boolean> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t) return false
    this.patchTab(id, { saving: true })
    try {
      const r = await this.deps.api.writeFile(root, t.path, content, expectedMtime)
      if (!this.tab(id)) return true
      const now = this.host?.getValue(id)
      this.patchTab(id, { saving: false, mtime: r.mtime, saved: content, dirty: now !== null && now !== undefined ? now !== content : false, conflict: null })
      this.filesStale = true
      return true
    } catch (e) {
      if (!this.tab(id)) return false
      if (e instanceof ApiError && e.code === 'conflict') {
        this.patchTab(id, { saving: false, conflict: { mtime: e.diskMtime, deleted: false } })
      } else {
        this.patchTab(id, { saving: false })
        this.notify(`Save failed: ${errText(e)}`)
      }
      return false
    }
  }

  /** Conflict bar "Overwrite": write my buffer over the version now on disk. */
  async overwrite(id: string): Promise<boolean> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t || t.kind !== 'file') return false
    const content = this.host?.getValue(id)
    if (content === null || content === undefined) return false
    let expected = t.conflict?.mtime ?? null
    if (t.conflict?.deleted) expected = null
    else if (expected === null) {
      try { expected = (await this.deps.api.readFile(root, t.path)).mtime } catch { /* write below decides */ }
    }
    return this.write(id, content, expected)
  }

  /** Conflict bar "Reload": take the disk version, dropping my edits. */
  async reload(id: string): Promise<void> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t || t.kind !== 'file') return
    try {
      const r = await this.deps.api.readFile(root, t.path)
      this.applyDisk(id, r.content ?? '', r.mtime, r.eol)
    } catch (e) {
      this.notify(`Reload failed: ${errText(e)}`)
    }
  }

  private applyDisk(id: string, text: string, mtime: number, eol: string): void {
    const t = this.tab(id)
    if (!t) return
    if (this.host?.setValue(id, text)) {
      const v = this.host.getValue(id) ?? text
      this.patchTab(id, { saved: v, mtime, dirty: false, conflict: null, eol: this.host.getEol(id) })
    } else {
      this.patchTab(id, { initial: text, saved: text, mtime, dirty: false, conflict: null, eol: eol === 'crlf' ? 'crlf' : 'lf' })
      if (this.s.active === id) this.syncEditor()
    }
  }

  /** Conflict bar "Compare": a diff tab of the disk version (left) against my buffer (right). */
  async compare(id: string): Promise<void> {
    const root = this.s.root
    const t = this.tab(id)
    if (root === null || !t || t.kind !== 'file') return
    try {
      const r = await this.deps.api.readFile(root, t.path)
      const mine = this.host?.getValue(id) ?? t.saved
      const cid = compareId(t.path)
      this.addTab({ ...blankTab(cid, 'compare', t.path), title: `${baseName(t.path)} (disk vs mine)`, loaded: true, of: id, diskMtime: r.mtime, diff: { original: r.content ?? '', modified: mine } })
      this.patchTab(id, { conflict: { mtime: r.mtime, deleted: false } })
      this.patchTab(cid, { diff: { original: r.content ?? '', modified: mine }, diskMtime: r.mtime })
      await this.activate(cid)
    } catch (e) {
      this.notify(`Compare failed: ${errText(e)}`)
    }
  }

  /** From a compare tab: keep mine (overwrite disk) or take the disk version. */
  async resolveCompare(cid: string, keep: 'mine' | 'disk'): Promise<void> {
    const c = this.tab(cid)
    if (!c || c.kind !== 'compare' || c.of === null) return
    const fid = c.of
    this.closeTab(cid, true)
    await this.activate(fid)
    if (keep === 'mine') await this.overwrite(fid)
    else await this.reload(fid)
  }

  // ---- git ----------------------------------------------------------------------------------------------------------

  /** Absolute path of a discovered repository (`rel` '' = the root, which is the repo when the root is inside a work tree). */
  repoPath(rel: string): string | null {
    if (rel === '') return this.s.root
    return this.s.repos.list?.find((r) => r.rel === rel)?.path ?? null
  }

  /** Git state of one repository: the root's own (`rel` '') or a nested one. */
  gitOf(rel: string): GitState | undefined { return rel === '' ? this.s.git : this.s.repoGit[rel] }

  /** Total number of changed entries over every shown repository. */
  changeCount(): number {
    let n = this.s.git.status?.files.length ?? 0
    for (const g of Object.values(this.s.repoGit)) n += g.status?.files.length ?? 0
    return n
  }

  /**
   * Refresh the CHANGES data: discover the repositories (first time, after a root switch, or `fresh`) and load their
   * status. Overlapping calls coalesce into one extra round.
   */
  refreshGit(fresh = false): Promise<void> {
    if (fresh) this.gitFresh = true
    if (this.gitInflight) { this.gitAgain = true; return this.gitInflight }
    const root = this.s.root
    if (root === null) return Promise.resolve()
    this.set({ git: { ...this.s.git, loading: true } })
    this.gitInflight = (async () => {
      try {
        await this.loadGit(root)
      } finally {
        this.gitInflight = null
        if (this.gitAgain) { this.gitAgain = false; void this.refreshGit() }
      }
    })()
    return this.gitInflight
  }

  private async loadGit(root: string): Promise<void> {
    const fresh = this.gitFresh
    this.gitFresh = false
    if (this.s.repos.list === null || fresh) {
      this.set({ repos: { ...this.s.repos, loading: true } })
      let found: RepoList
      try {
        found = await this.deps.api.gitRepos(root, fresh)
      } catch (e) {
        if (this.s.root !== root) return
        if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
          // A host without /git/repos: treat the root as the repository, like before.
          found = { inside: true, truncated: false, repos: [{ path: root, rel: '', name: baseName(root) }] }
        } else {
          this.set({ repos: { ...this.s.repos, loading: false, error: errText(e) }, git: { ...this.s.git, loading: false, error: errText(e) } })
          return
        }
      }
      if (this.s.root !== root) return
      const nested = found.repos.filter((r) => r.rel !== '')
      // Nested repositories lie inside the registered root: register them so the git routes accept them as `root`.
      if (nested.length > 0) {
        try { await this.register(nested.map((r) => r.path)) } catch (e) { this.notify(`Could not register repositories: ${errText(e)}`) }
        if (this.s.root !== root) return
      }
      const keep: Record<string, GitState> = {}
      for (const r of nested) if (this.s.repoGit[r.rel]) keep[r.rel] = this.s.repoGit[r.rel]
      this.set({ repos: { list: found.repos, loading: false, truncated: found.truncated, error: null }, repoGit: keep })
    }
    const list = this.s.repos.list ?? []
    if (list.length === 0) {
      this.set({ git: { status: null, notGit: true, error: null, loading: false }, repoGit: {} })
      return
    }
    if (list.some((r) => r.rel === '')) {
      try {
        const status = await this.deps.api.gitStatus(root)
        if (this.s.root === root) this.set({ git: { status, notGit: false, error: null, loading: false } })
      } catch (e) {
        if (this.s.root !== root) return
        if (e instanceof ApiError && e.code === 'not-git') this.set({ git: { status: null, notGit: true, error: null, loading: false } })
        else this.set({ git: { status: this.s.git.status, notGit: false, error: errText(e), loading: false } })
      }
      return
    }
    this.set({ git: { status: null, notGit: false, error: null, loading: false } })
    const queue = list.map((r) => r.rel)
    const worker = async (): Promise<void> => { for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) await this.loadRepoStatus(rel) }
    await Promise.all([worker(), worker(), worker(), worker()])
  }

  private async loadRepoStatus(rel: string): Promise<void> {
    const root = this.s.root
    const abs = this.repoPath(rel)
    if (root === null || abs === null || rel === '') return
    const prev = this.s.repoGit[rel]
    this.set({ repoGit: { ...this.s.repoGit, [rel]: { status: prev?.status ?? null, notGit: false, error: null, loading: true } } })
    const put = (g: GitState): void => { if (this.s.root === root && this.s.repos.list?.some((r) => r.rel === rel)) this.set({ repoGit: { ...this.s.repoGit, [rel]: g } }) }
    try {
      put({ status: await this.deps.api.gitStatus(abs), notGit: false, error: null, loading: false })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'not-git') put({ status: null, notGit: true, error: null, loading: false })
      else put({ status: prev?.status ?? null, notGit: false, error: errText(e), loading: false })
    }
  }

  /** Refresh one repository's status (`rel` '' = the root repository). */
  private refreshRepo(rel: string): Promise<void> { return rel === '' ? this.refreshGit() : this.loadRepoStatus(rel) }

  private scheduleGit(): void {
    if (this.gitTimer !== null) return
    this.gitTimer = setTimeout(() => { this.gitTimer = null; void this.refreshGit(); void this.refreshDiffTabs() }, this.deps.gitDelayMs ?? 250)
  }

  private async gitOp(fn: (repoRoot: string) => Promise<void>, what: string, repo = ''): Promise<boolean> {
    const abs = this.repoPath(repo)
    if (this.s.root === null || abs === null) return false
    try {
      await fn(abs)
      await this.refreshRepo(repo)
      await this.refreshDiffTabs()
      return true
    } catch (e) {
      this.notify(`${what} failed: ${errText(e)}`)
      void this.refreshRepo(repo)
      return false
    }
  }

  /** Stage / unstage / discard take paths relative to the repository `repo` (root-relative folder, '' = the root). */
  stage(paths: string[], repo = ''): Promise<boolean> { return this.gitOp((r) => this.deps.api.stage(r, paths), 'Stage', repo) }
  unstage(paths: string[], repo = ''): Promise<boolean> { return this.gitOp((r) => this.deps.api.unstage(r, paths), 'Unstage', repo) }

  /** Discard asks first and lists the untracked files that will be deleted. False when cancelled or failed. */
  async discard(files: GitFile[], repo = ''): Promise<boolean> {
    if (files.length === 0) return false
    const plan = planDiscard(files)
    if (!this.confirm(plan.message)) return false
    return this.gitOp((r) => this.deps.api.discard(r, plan.paths, plan.untracked), 'Discard', repo)
  }

  stageAll(repo = ''): Promise<boolean> {
    const g = groupChanges(this.gitOf(repo)?.status)
    return this.stage([...g.changes, ...g.untracked].map((f) => f.path), repo)
  }
  unstageAll(repo = ''): Promise<boolean> { return this.unstage(groupChanges(this.gitOf(repo)?.status).staged.map((f) => f.path), repo) }

  private async refreshDiffTabs(): Promise<void> {
    const root = this.s.root
    if (root === null) return
    for (const t of this.s.tabs.filter((x) => x.kind === 'diff' && x.loaded)) {
      try {
        const where = this.diffTarget(t)
        if (where === null) continue
        const r = await this.deps.api.gitDiff(where.root, where.path, t.staged)
        if (this.s.root !== root || !this.tab(t.id) || r.binary || r.tooLarge) continue
        const diff = { original: r.original ?? '', modified: r.modified ?? '' }
        if (t.diff && t.diff.original === diff.original && t.diff.modified === diff.modified) continue
        this.patchTab(t.id, { diff })
        if (this.s.active === t.id) this.syncEditor()
      } catch { /* the entry may be gone from the status: keep what is shown */ }
    }
  }

  // ---- live updates ---------------------------------------------------------------------------------------------

  private closeLive(): void {
    this.live?.close()
    this.live = null
    this.set({ live: 'down' })
  }

  private openLiveSocket(root: string): void {
    this.live = openLive({
      url: this.deps.api.wsUrl(root),
      Socket: this.deps.Socket,
      delay: this.deps.wsDelay,
      onState: (state, again) => {
        if (this.s.root !== root) return
        this.set({ live: state })
        if (state === 'live' && again) void this.refreshAll()
      },
      onFrame: (f) => { if (this.s.root === root) this.handleFrame(f) },
    })
  }

  /** After a reconnect events may have been missed: refresh everything. */
  async refreshAll(): Promise<void> {
    this.filesStale = true
    await Promise.all([this.refreshExplorer(), this.refreshGit(), this.refreshOpenTabs([], true)])
    void this.refreshDiffTabs()
  }

  handleFrame(f: WsFrame): void {
    if (f.type === 'git') {
      this.scheduleGit()
    } else if (f.type === 'changed') {
      this.filesStale = true
      if (f.overflow) {
        void this.refreshExplorer()
      } else {
        const dirs = new Set(f.paths.map(dirName))
        for (const d of dirs) if (this.s.tree[d]?.entries) void this.loadDir(d, true)
      }
      void this.refreshOpenTabs(f.paths, f.overflow === true)
      this.scheduleGit()
    }
  }

  /** Open file tabs whose file changed on disk: clean ones reload silently, dirty ones raise the conflict bar. */
  async refreshOpenTabs(paths: string[], all: boolean): Promise<void> {
    const root = this.s.root
    if (root === null) return
    const set = new Set(paths.map((p) => normKey(p)))
    const targets = this.s.tabs.filter((t) => t.kind === 'file' && t.loaded && !t.binary && !t.tooLarge && (all || set.has(normKey(t.path))))
    await Promise.all(targets.map(async (t) => {
      try {
        const r = await this.deps.api.readFile(root, t.path)
        const cur = this.tab(t.id)
        if (this.s.root !== root || !cur || cur.saving) return
        if (cur.mtime !== null && r.mtime === cur.mtime) return
        if (r.binary || r.tooLarge || r.content === null) return
        if (!cur.dirty) {
          // Same text (e.g. our own save seen through another mtime): only remember the new mtime.
          if (r.content === cur.saved) { this.patchTab(t.id, { mtime: r.mtime }); return }
          this.applyDisk(t.id, r.content, r.mtime, r.eol)
        } else if (r.content !== cur.saved) {
          this.patchTab(t.id, { conflict: { mtime: r.mtime, deleted: false } })
        } else {
          this.patchTab(t.id, { mtime: r.mtime })
        }
      } catch (e) {
        const cur = this.tab(t.id)
        if (e instanceof ApiError && e.status === 404 && cur?.dirty) this.patchTab(t.id, { conflict: { mtime: null, deleted: true } })
      }
    }))
  }

  // ---- cross-plugin open ----------------------------------------------------------------------------------------

  /** Handle `dsh-code-editor:open`: resolve the root, open the file / review view, then switch to the Code page. */
  async handleOpenRequest(detail: unknown): Promise<boolean> {
    const d = detail as Partial<OpenRequest> | null
    if (!d || typeof d.path !== 'string' || d.path.length === 0) return false
    const abs = d.path
    const line = typeof d.line === 'number' && d.line > 0 ? Math.floor(d.line) : undefined
    const col = typeof d.col === 'number' && d.col > 0 ? Math.floor(d.col) : undefined
    try {
      let root: string | null = null
      if (typeof d.root === 'string' && d.root.length > 0) {
        root = this.knownRoots().find((r) => sameRoot(r, d.root as string)) ?? null
        if (root === null) {
          const info = (await this.register([d.root]))[0]
          root = info?.exists ? info.path : null
        }
      } else {
        // The folder already open wins: nested repositories are registered roots too and must not steal the page.
        root = this.s.root !== null && relativeTo(this.s.root, abs) !== null ? this.s.root : findRoot(this.knownRoots(), abs)
        if (root === null) {
          const resolved = await this.deps.api.resolve(abs)
          const candidate = resolved?.root ?? abs.replace(/[\\/][^\\/]*$/, '')
          const info = (await this.register([candidate]))[0]
          root = info?.exists ? info.path : null
        }
      }
      if (root === null || relativeTo(root, abs) === null) { this.notify(`Cannot open ${abs}: not inside a folder the editor can use.`); return false }
      this.deps.selectPanel?.()
      if (this.s.root === null || !sameRoot(this.s.root, root)) {
        if (!(await this.selectRoot(root))) return false
      }
      const rel = relativeTo(root, abs) as string
      if (d.review === true && (rel === '' || (await this.isDirectory(root, rel)))) {
        // A folder: show the CHANGES view of the root (the folder only matters for choosing the root).
        this.set({ changesFocus: this.s.changesFocus + 1 })
        this.setLayout({ chOpen: true })
        await this.refreshGit(true)
      } else if (d.review === true) {
        await this.refreshGit(true)
        const hit = this.changeFor(rel)
        if (hit) await this.openDiff(rel, !hit.file.unstaged && hit.file.staged, hit.repo)
        else await this.openFile(rel, { line, col })
      } else {
        await this.openFile(rel, { line, col })
      }
      this.deps.selectPanel?.()
      return true
    } catch (e) {
      this.notify(`Cannot open ${abs}: ${errText(e)}`)
      return false
    }
  }

  /** The status entry for a root-relative file, with the root-relative folder of its repository. */
  private changeFor(rel: string): { repo: string; file: GitFile } | null {
    const lookup = (repo: string, status: GitStatus | null | undefined): { repo: string; file: GitFile } | null => {
      const inner = repo === '' ? rel : rel.startsWith(`${repo}/`) ? rel.slice(repo.length + 1) : null
      const file = inner === null ? undefined : status?.files.find((x) => x.path === inner)
      return file ? { repo, file } : null
    }
    const own = lookup('', this.s.git.status)
    if (own) return own
    for (const [repo, g] of Object.entries(this.s.repoGit)) {
      const hit = lookup(repo, g.status)
      if (hit) return hit
    }
    return null
  }

  /** True when `rel` (below `root`) lists as a folder. */
  private async isDirectory(root: string, rel: string): Promise<boolean> {
    try { await this.deps.api.tree(root, rel); return true } catch { return false }
  }

  dispose(): void {
    this.closeLive()
    if (this.gitTimer !== null) clearTimeout(this.gitTimer)
    this.host?.dispose()
    this.host = null
  }
}
