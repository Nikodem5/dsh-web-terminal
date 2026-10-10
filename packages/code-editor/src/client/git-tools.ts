// dsh-code-editor - client logic of the git tools: commit box, branch picker, history and sync (fetch / pull / push).
// Its own small store (subscribe / getState) so the page store stays focused; everything it needs from the page comes
// through `GitToolsHost`. No DOM: unit-testable against a fake Api. Repositories are keyed by `rel` ('' = the root).

import type { Api } from './api.ts'
import { groupChanges } from './changes.ts'
import type { BranchInfo, CommitDetail, CommitFile, CommitSummary } from './git-api.ts'
import { baseName, joinRel } from './paths.ts'
import type { GitStatus } from './types.ts'

export const HISTORY_PAGE = 50
export const SUBJECT_HINT = 72

export interface GitToolsHost {
  api: Api
  root(): string | null
  /** Absolute path of a repository (the `root` the git routes get). */
  repoPath(rel: string): string | null
  /** The repositories shown in CHANGES. */
  repos(): Array<{ rel: string; name: string }>
  status(rel: string): GitStatus | null | undefined
  confirm(message: string): boolean
  notify(text: string, level?: 'info' | 'error'): void
  /** Refresh CHANGES / status of one repository; `everything` also reloads the explorer and open files (branch switch, pull). */
  refresh(rel: string, everything: boolean): Promise<void>
  /** Open a read-only diff tab. */
  openStaticDiff(d: { id: string; path: string; title: string; original: string; modified: string }): Promise<void>
}

export interface CommitDraft { message: string; amend: boolean; busy: boolean; error: string | null; prefill: string | null; pushed: boolean }
export type SyncKind = 'fetch' | 'pull' | 'push'
export interface SyncState { busy: SyncKind | null; error: string | null; info: string | null }
export interface PickerState { repo: string; loading: boolean; busy: boolean; error: string | null; info: BranchInfo | null }
export interface HistoryState {
  open: boolean
  repo: string
  /** File history: repository-relative path, '' = the whole branch. */
  path: string
  commits: CommitSummary[]
  hasMore: boolean
  loading: boolean
  error: string | null
  selected: string | null
  detail: CommitDetail | null
  detailLoading: boolean
  detailError: string | null
}
export interface GitToolsState {
  commit: Record<string, CommitDraft>
  sync: Record<string, SyncState>
  picker: PickerState | null
  history: HistoryState
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const BLANK_DRAFT: CommitDraft = { message: '', amend: false, busy: false, error: null, prefill: null, pushed: false }
const BLANK_SYNC: SyncState = { busy: null, error: null, info: null }
const blankHistory = (): HistoryState => ({ open: false, repo: '', path: '', commits: [], hasMore: false, loading: false, error: null, selected: null, detail: null, detailLoading: false, detailError: null })
const initial = (): GitToolsState => ({ commit: {}, sync: {}, picker: null, history: blankHistory() })

/** "3 minutes ago" style age; falls back to a date after a month. */
export function relativeDate(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const unit = (n: number, name: string): string => `${n} ${name}${n === 1 ? '' : 's'} ago`
  if (s < 3600) return unit(Math.max(1, Math.round(s / 60)), 'minute')
  if (s < 86400) return unit(Math.round(s / 3600), 'hour')
  if (s < 86400 * 30) return unit(Math.round(s / 86400), 'day')
  return new Date(ms).toISOString().slice(0, 10)
}

/** First line of a commit message is longer than the usual subject limit. */
export const subjectTooLong = (message: string): boolean => (message.split('\n')[0] ?? '').length > SUBJECT_HINT

export class GitTools {
  private s: GitToolsState = initial()
  private listeners = new Set<() => void>()
  private gen = 0
  private historyToken = 0
  private readonly host: GitToolsHost

  constructor(host: GitToolsHost) { this.host = host }

  getState = (): GitToolsState => this.s
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  private set(patch: Partial<GitToolsState>): void {
    this.s = { ...this.s, ...patch }
    for (const l of [...this.listeners]) l()
  }
  private setDraft(rel: string, patch: Partial<CommitDraft>): void {
    this.set({ commit: { ...this.s.commit, [rel]: { ...this.draft(rel), ...patch } } })
  }
  private setSync(rel: string, patch: Partial<SyncState>): void {
    this.set({ sync: { ...this.s.sync, [rel]: { ...this.syncOf(rel), ...patch } } })
  }
  private setHistory(patch: Partial<HistoryState>): void { this.set({ history: { ...this.s.history, ...patch } }) }

  draft(rel: string): CommitDraft { return this.s.commit[rel] ?? BLANK_DRAFT }
  syncOf(rel: string): SyncState { return this.s.sync[rel] ?? BLANK_SYNC }

  /** The page switched folder: forget everything. In-flight answers are ignored. */
  reset(): void {
    this.gen++
    this.historyToken++
    this.s = initial()
    for (const l of [...this.listeners]) l()
  }

  private name(rel: string): string { return this.host.repos().find((r) => r.rel === rel)?.name ?? baseName(this.host.repoPath(rel) ?? '') }

  // ---- commit -------------------------------------------------------------------------------------------------------

  setMessage(rel: string, message: string): void { this.setDraft(rel, { message, error: null }) }

  /** The "Amend last commit" checkbox: prefills the last message and learns whether it is already pushed. */
  async setAmend(rel: string, on: boolean): Promise<void> {
    const d = this.draft(rel)
    if (!on) {
      this.setDraft(rel, { amend: false, pushed: false, error: null, prefill: null, ...(d.prefill !== null && d.message === d.prefill ? { message: '' } : {}) })
      return
    }
    const abs = this.host.repoPath(rel)
    if (abs === null) return
    const gen = this.gen
    this.setDraft(rel, { amend: true, error: null })
    try {
      const last = await this.host.api.gitLastCommit(abs)
      if (gen !== this.gen || !this.draft(rel).amend) return
      if (last.hash === null) {
        this.setDraft(rel, { amend: false, error: 'There is no commit to amend yet.' })
        return
      }
      const cur = this.draft(rel)
      this.setDraft(rel, { prefill: last.message, pushed: last.pushed, ...(cur.message.trim() === '' ? { message: last.message } : {}) })
    } catch (e) {
      if (gen === this.gen) this.setDraft(rel, { amend: false, error: errText(e) })
    }
  }

  /**
   * Commit the staged changes. Nothing staged: after a confirm, `git commit -a` (tracked changes only). Amending a
   * commit that is already on the upstream branch asks first. False when refused, cancelled or failed.
   */
  async commit(rel: string): Promise<boolean> {
    const abs = this.host.repoPath(rel)
    const d = this.draft(rel)
    if (abs === null || d.busy) return false
    const message = d.message.trim()
    if (message === '' && !d.amend) {
      this.setDraft(rel, { error: 'Enter a commit message.' })
      return false
    }
    const groups = groupChanges(this.host.status(rel))
    let all = false
    if (groups.staged.length === 0 && !d.amend) {
      if (groups.changes.length === 0) {
        this.setDraft(rel, { error: 'Nothing to commit: no staged or modified tracked files.' })
        return false
      }
      const n = groups.changes.length
      if (!this.host.confirm(`Nothing is staged in "${this.name(rel)}". Commit all ${n} modified tracked file${n === 1 ? '' : 's'} (git commit -a)? Untracked files are not included.`)) return false
      all = true
    }
    if (d.amend && d.pushed && !this.host.confirm(`The last commit of "${this.name(rel)}" is already on its upstream branch. Amending rewrites it and the next push would need a force push, which this editor never does. Amend anyway?`)) return false
    const gen = this.gen
    this.setDraft(rel, { busy: true, error: null })
    try {
      const r = await this.host.api.gitCommit(abs, { message, amend: d.amend, all })
      if (gen !== this.gen) return true
      this.setDraft(rel, { ...BLANK_DRAFT })
      this.host.notify(`${d.amend ? 'Amended' : 'Committed'} ${r.hash.slice(0, 7)}: ${r.summary}`, 'info')
      await this.host.refresh(rel, false)
      void this.reloadHistoryFor(rel)
      return true
    } catch (e) {
      if (gen === this.gen) this.setDraft(rel, { busy: false, error: errText(e) })
      void this.host.refresh(rel, false)
      return false
    }
  }

  // ---- branches ------------------------------------------------------------------------------------------------------

  async openPicker(rel: string): Promise<void> {
    const abs = this.host.repoPath(rel)
    if (abs === null) return
    const gen = this.gen
    this.set({ picker: { repo: rel, loading: true, busy: false, error: null, info: null } })
    try {
      const info = await this.host.api.gitBranches(abs)
      if (gen !== this.gen || this.s.picker?.repo !== rel) return
      this.set({ picker: { repo: rel, loading: false, busy: false, error: null, info } })
    } catch (e) {
      if (gen === this.gen && this.s.picker?.repo === rel) this.set({ picker: { repo: rel, loading: false, busy: false, error: errText(e), info: null } })
    }
  }

  closePicker(): void { if (this.s.picker !== null) this.set({ picker: null }) }

  /** Switch to a local branch, check out a remote one (`origin/x`, creating a tracking branch) or create `branch` from HEAD. Git decides about uncommitted changes. */
  async checkout(rel: string, branch: string, create = false): Promise<boolean> {
    const abs = this.host.repoPath(rel)
    const p = this.s.picker
    const name = branch.trim()
    if (abs === null || p === null || p.repo !== rel || p.busy) return false
    if (name === '') {
      this.set({ picker: { ...p, error: 'Enter a branch name.' } })
      return false
    }
    const gen = this.gen
    this.set({ picker: { ...p, busy: true, error: null } })
    try {
      const r = await this.host.api.gitCheckout(abs, name, create)
      if (gen !== this.gen) return true
      this.set({ picker: null })
      this.host.notify(create ? `Created and switched to "${r.branch}".` : `Switched to "${r.branch}".`, 'info')
      await this.host.refresh(rel, true)
      void this.reloadHistoryFor(rel)
      return true
    } catch (e) {
      const cur = this.s.picker
      if (gen === this.gen && cur !== null && cur.repo === rel) this.set({ picker: { ...cur, busy: false, error: errText(e) } })
      void this.host.refresh(rel, false)
      return false
    }
  }

  // ---- sync ------------------------------------------------------------------------------------------------------------

  /**
   * Fetch (no confirmation) / pull (fast-forward only) / push. Pull and push first ask the user, naming repository,
   * branch and remote. Resolves true when it ran and succeeded.
   */
  async sync(rel: string, kind: SyncKind): Promise<boolean> {
    const abs = this.host.repoPath(rel)
    if (abs === null || this.syncOf(rel).busy !== null) return false
    const gen = this.gen
    this.setSync(rel, { busy: kind, error: null, info: null })
    try {
      let remote: string | undefined
      if (kind !== 'fetch') {
        const info = await this.host.api.gitBranches(abs)
        if (gen !== this.gen) return false
        const refusal = this.preflight(kind, info)
        if (refusal !== null) {
          this.setSync(rel, { busy: null, error: refusal })
          return false
        }
        if (!this.host.confirm(this.confirmText(rel, kind, info))) {
          this.setSync(rel, { busy: null })
          return false
        }
        remote = kind === 'push' ? this.pushRemote(info) : undefined
      }
      const r = kind === 'fetch' ? await this.host.api.gitFetch(abs) : kind === 'pull' ? await this.host.api.gitPull(abs) : await this.host.api.gitPush(abs, remote)
      if (gen !== this.gen) return true
      this.setSync(rel, { busy: null, info: r.summary })
      await this.host.refresh(rel, kind === 'pull')
      void this.reloadHistoryFor(rel)
      return true
    } catch (e) {
      if (gen === this.gen) this.setSync(rel, { busy: null, error: errText(e) })
      void this.host.refresh(rel, false)
      return false
    }
  }

  private preflight(kind: SyncKind, info: BranchInfo): string | null {
    if (info.remotes.length === 0) return 'This repository has no remote.'
    if (info.detached || info.current === null) return 'HEAD is detached: switch to a branch first.'
    if (kind === 'pull' && info.upstream === null) return `Branch "${info.current}" has no upstream branch to pull from. Push it first.`
    return null
  }

  /** Remote to push a branch without upstream to: origin, else the first one. */
  private pushRemote(info: BranchInfo): string | undefined {
    if (info.upstream !== null) return undefined
    return info.remotes.includes('origin') ? 'origin' : info.remotes[0]
  }

  private confirmText(rel: string, kind: SyncKind, info: BranchInfo): string {
    const repo = this.name(rel)
    const branch = info.current ?? '?'
    if (kind === 'pull') {
      const behind = info.behind
      return `Pull into "${repo}", branch "${branch}", from ${info.upstream ?? 'its upstream'}${behind !== null ? ` (${behind} incoming commit${behind === 1 ? '' : 's'} known)` : ''}?\nFast-forward only: no merge commit is created and a diverged branch is left untouched.`
    }
    if (info.upstream === null) {
      const remote = this.pushRemote(info) ?? 'origin'
      return `Push new branch "${branch}" of "${repo}" to remote "${remote}" and set it as the upstream (git push -u ${remote} ${branch})?`
    }
    const ahead = info.ahead
    return `Push ${ahead !== null ? `${ahead} commit${ahead === 1 ? '' : 's'} of ` : ''}branch "${branch}" in "${repo}" to remote "${info.upstreamRemote ?? info.upstream.split('/')[0]}" (${info.upstream})?`
  }

  // ---- history ----------------------------------------------------------------------------------------------------------

  /** The repository a root-relative path lies in, with the repository-relative remainder. */
  private repoOf(path: string): { rel: string; path: string } {
    let best = ''
    for (const r of this.host.repos()) if (r.rel !== '' && (path === r.rel || path.startsWith(`${r.rel}/`)) && r.rel.length > best.length) best = r.rel
    return { rel: best, path: best === '' ? path : path.slice(best.length + 1) }
  }

  private defaultRepo(): string {
    const list = this.host.repos()
    return list.some((r) => r.rel === '') ? '' : (list[0]?.rel ?? '')
  }

  /** Show or hide the HISTORY section; opening loads the first page. */
  async setHistoryOpen(open: boolean): Promise<void> {
    if (!open) { this.setHistory({ open: false }); return }
    const h = this.s.history
    const repo = this.host.repos().some((r) => r.rel === h.repo) ? h.repo : this.defaultRepo()
    this.setHistory({ open: true, repo })
    if (h.commits.length === 0 || repo !== h.repo) await this.loadHistory(true)
  }

  async setHistoryRepo(rel: string): Promise<void> {
    if (rel === this.s.history.repo) return
    this.setHistory({ repo: rel, path: '', commits: [], hasMore: false, selected: null, detail: null, detailError: null })
    await this.loadHistory(true)
  }

  /** History of one file (root-relative path): opens the section filtered to it. */
  async fileHistory(path: string): Promise<void> {
    const where = this.repoOf(path)
    this.setHistory({ open: true, repo: where.rel, path: where.path, commits: [], hasMore: false, selected: null, detail: null, detailError: null })
    await this.loadHistory(true)
  }

  async clearFileFilter(): Promise<void> {
    if (this.s.history.path === '') return
    this.setHistory({ path: '', commits: [], hasMore: false, selected: null, detail: null })
    await this.loadHistory(true)
  }

  /** Load the first page (`reset`) or the next one. */
  async loadHistory(reset = false): Promise<void> {
    const h = this.s.history
    const abs = this.host.repoPath(h.repo)
    if (abs === null || (h.loading && !reset)) return
    const token = ++this.historyToken
    const skip = reset ? 0 : h.commits.length
    this.setHistory({ loading: true, error: null, ...(reset ? { commits: [], hasMore: false } : {}) })
    try {
      const page = await this.host.api.gitLog(abs, { skip, limit: HISTORY_PAGE, path: h.path === '' ? undefined : h.path })
      if (token !== this.historyToken) return
      this.setHistory({ loading: false, commits: reset ? page.commits : [...this.s.history.commits, ...page.commits], hasMore: page.hasMore })
    } catch (e) {
      if (token === this.historyToken) this.setHistory({ loading: false, error: errText(e) })
    }
  }

  private async reloadHistoryFor(rel: string): Promise<void> {
    const h = this.s.history
    if (h.open && h.repo === rel) await this.loadHistory(true)
  }

  /** Click on a commit: list its changed files (click again to collapse). */
  async selectCommit(hash: string): Promise<void> {
    const h = this.s.history
    const abs = this.host.repoPath(h.repo)
    if (abs === null) return
    if (h.selected === hash) { this.setHistory({ selected: null, detail: null, detailError: null }); return }
    const token = this.historyToken
    this.setHistory({ selected: hash, detail: null, detailLoading: true, detailError: null })
    try {
      const detail = await this.host.api.gitCommitInfo(abs, hash)
      if (token === this.historyToken && this.s.history.selected === hash) this.setHistory({ detail, detailLoading: false })
    } catch (e) {
      if (token === this.historyToken && this.s.history.selected === hash) this.setHistory({ detailLoading: false, detailError: errText(e) })
    }
  }

  /** Click on a file of the selected commit: read-only diff (parent vs commit) in the diff editor. */
  async openCommitFile(file: CommitFile): Promise<void> {
    const h = this.s.history
    const hash = h.selected
    const abs = this.host.repoPath(h.repo)
    if (abs === null || hash === null) return
    try {
      const r = await this.host.api.gitShow(abs, hash, file.path, file.origPath)
      const full = joinRel(h.repo, file.path)
      if (r.binary) { this.host.notify(`${baseName(file.path)}: binary file, not shown.`, 'info'); return }
      if (r.tooLarge) { this.host.notify(`${baseName(file.path)}: larger than 2 MiB, not shown.`, 'info'); return }
      await this.host.openStaticDiff({ id: `hist:${abs}:${hash}:${full}`, path: full, title: `${baseName(file.path)} (${hash.slice(0, 7)})`, original: r.original ?? '', modified: r.modified ?? '' })
    } catch (e) {
      this.host.notify(`Could not show ${file.path}: ${errText(e)}`)
    }
  }
}
