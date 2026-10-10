// dsh-code-editor - the page logic: roots, explorer, tabs (dirty / conflict state machine), git changes,
// live updates, persistence and the cross-plugin open request. No DOM and no Monaco: the editor is an
// `EditorHost` handed in through `attachHost`, the host through `Api`, so all of this is unit-testable.

import type { EditorHost, AdapterFactory } from './adapter.ts'
import { ApiError, type Api } from './api.ts'
import { groupChanges, planDiscard } from './changes.ts'
import { baseName, dirName, findRoot, joinRel, languageFor, normKey, relativeTo, sameRoot } from './paths.ts'
import { defaultStorage, loadGlobal, loadRootState, saveGlobal, saveRootState, type StorageLike } from './persist.ts'
import type { GitFile, GitStatus, OpenRequest, RootInfo, TreeEntry, WsFrame } from './types.ts'
import { openLive, type LiveState, type SocketCtor } from './ws.ts'

export interface TreeNode { entries: TreeEntry[] | null; loading: boolean; error: string | null }

export interface Tab {
  id: string
  kind: 'file' | 'diff' | 'compare'
  path: string
  /** Diff tabs: the staged (HEAD vs index) or unstaged (index vs work tree) side. */
  staged: boolean
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
  git: { status: GitStatus | null; notGit: boolean; error: string | null; loading: boolean }
  tabs: Tab[]
  active: string | null
  inline: boolean
  cursor: { line: number; col: number } | null
  live: LiveState
  quickOpen: boolean
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
  /** Coalescing delay for git refreshes after a `changed` frame, ms. */
  gitDelayMs?: number
  /** Reconnect delay override (tests). */
  wsDelay?: (n: number) => number
}

const fileId = (path: string): string => `file:${path}`
const diffId = (path: string, staged: boolean): string => `diff:${staged ? 's' : 'w'}:${path}`
const compareId = (path: string): string => `cmp:${path}`
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const blankTab = (id: string, kind: Tab['kind'], path: string, staged = false): Tab => ({
  id, kind, path, staged, title: baseName(path), language: languageFor(path), loaded: false, loading: false, error: null, mtime: null, saved: '', initial: null,
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
      tabs: [], active: null, inline: false, cursor: null, live: 'down', quickOpen: false, notice: null, hostReady: false, recent: [],
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
        saveGlobal(this.storage, { lastRoot: this.s.root, folders: this.folders })
      }
      return await this.selectRoot(info.path)
    } catch (e) {
      this.notify(`Could not open folder: ${errText(e)}`)
      return false
    }
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
      git: { status: null, notGit: false, error: null, loading: false }, recent: [],
    })
    this.host?.showNone()
    saveGlobal(this.storage, { lastRoot: root, folders: this.folders })
    this.openLiveSocket(root)
    void this.loadDir('')
    for (const d of st.expanded) void this.loadDir(d)
    void this.refreshGit()
    // Restore tabs (the active one loads first; the rest load when activated).
    for (const t of st.tabs) this.addTab(t.kind === 'diff' ? blankTab(diffId(t.path, t.staged === true), 'diff', t.path, t.staged === true) : blankTab(fileId(t.path), 'file', t.path))
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
      tabs: this.s.tabs.filter((t) => t.kind !== 'compare').map((t) => (t.kind === 'diff' ? { kind: 'diff' as const, path: t.path, staged: t.staged } : { kind: 'file' as const, path: t.path })),
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

  async openDiff(path: string, staged: boolean): Promise<void> {
    const id = diffId(path, staged)
    this.addTab(blankTab(id, 'diff', path, staged))
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
      const r = await this.deps.api.gitDiff(root, t.path, t.staged)
      if (this.s.root !== root || !this.tab(id)) return
      const skip = r.binary || r.tooLarge
      this.patchTab(id, { loading: false, loaded: true, binary: r.binary, tooLarge: r.tooLarge, diff: skip ? null : { original: r.original ?? '', modified: r.modified ?? '' } })
    } catch (e) {
      if (this.s.root !== root || !this.tab(id)) return
      this.patchTab(id, { loading: false, error: errText(e) })
    }
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

  refreshGit(): Promise<void> {
    if (this.gitInflight) { this.gitAgain = true; return this.gitInflight }
    const root = this.s.root
    if (root === null) return Promise.resolve()
    this.set({ git: { ...this.s.git, loading: true } })
    this.gitInflight = (async () => {
      try {
        const status = await this.deps.api.gitStatus(root)
        if (this.s.root === root) this.set({ git: { status, notGit: false, error: null, loading: false } })
      } catch (e) {
        if (this.s.root !== root) return
        if (e instanceof ApiError && e.code === 'not-git') this.set({ git: { status: null, notGit: true, error: null, loading: false } })
        else this.set({ git: { status: this.s.git.status, notGit: false, error: errText(e), loading: false } })
      } finally {
        this.gitInflight = null
        if (this.gitAgain) { this.gitAgain = false; void this.refreshGit() }
      }
    })()
    return this.gitInflight
  }

  private scheduleGit(): void {
    if (this.gitTimer !== null) return
    this.gitTimer = setTimeout(() => { this.gitTimer = null; void this.refreshGit(); void this.refreshDiffTabs() }, this.deps.gitDelayMs ?? 250)
  }

  private async gitOp(fn: (root: string) => Promise<void>, what: string): Promise<boolean> {
    const root = this.s.root
    if (root === null) return false
    try {
      await fn(root)
      await this.refreshGit()
      await this.refreshDiffTabs()
      return true
    } catch (e) {
      this.notify(`${what} failed: ${errText(e)}`)
      void this.refreshGit()
      return false
    }
  }

  stage(paths: string[]): Promise<boolean> { return this.gitOp((r) => this.deps.api.stage(r, paths), 'Stage') }
  unstage(paths: string[]): Promise<boolean> { return this.gitOp((r) => this.deps.api.unstage(r, paths), 'Unstage') }

  /** Discard asks first and lists the untracked files that will be deleted. False when cancelled or failed. */
  async discard(files: GitFile[]): Promise<boolean> {
    if (files.length === 0) return false
    const plan = planDiscard(files)
    if (!this.confirm(plan.message)) return false
    return this.gitOp((r) => this.deps.api.discard(r, plan.paths, plan.untracked), 'Discard')
  }

  stageAll(): Promise<boolean> {
    const g = groupChanges(this.s.git.status)
    return this.stage([...g.changes, ...g.untracked].map((f) => f.path))
  }
  unstageAll(): Promise<boolean> { return this.unstage(groupChanges(this.s.git.status).staged.map((f) => f.path)) }

  private async refreshDiffTabs(): Promise<void> {
    const root = this.s.root
    if (root === null) return
    for (const t of this.s.tabs.filter((x) => x.kind === 'diff' && x.loaded)) {
      try {
        const r = await this.deps.api.gitDiff(root, t.path, t.staged)
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
        root = findRoot(this.knownRoots(), abs)
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
      if (d.review === true) {
        await this.refreshGit()
        const f = this.s.git.status?.files.find((x) => x.path === rel)
        if (f && !f.untracked) await this.openDiff(rel, !f.unstaged && f.staged)
        else if (f && f.untracked) await this.openDiff(rel, false)
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

  dispose(): void {
    this.closeLive()
    if (this.gitTimer !== null) clearTimeout(this.gitTimer)
    this.host?.dispose()
    this.host = null
  }
}
