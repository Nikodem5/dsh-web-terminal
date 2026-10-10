// dsh-code-editor - UI of the git tools: per-repository sync bar + commit box (CHANGES), the branch picker, the
// HISTORY section. State and rules live in git-tools.ts; this file only draws them.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { groupChanges } from './changes.ts'
import { FileIcon } from './file-icon.tsx'
import type { CommitFile } from './git-api.ts'
import { SUBJECT_HINT, relativeDate, subjectTooLong, type GitToolsState } from './git-tools.ts'
import { baseName } from './paths.ts'
import type { EditorStore, GitState } from './store.ts'

export function useGitTools(store: EditorStore): GitToolsState {
  return useSyncExternalStore(store.gitTools.subscribe, store.gitTools.getState, store.gitTools.getState)
}

const BranchGlyph = (): ReactElement => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.7" /><circle cx="4.5" cy="12.5" r="1.7" /><circle cx="11.5" cy="5.5" r="1.7" /><path d="M4.5 5.2v5.6M11.5 7.2c0 2.6-3 2.4-7 4.2" /></svg>
)
const Spinner = (): ReactElement => <span className="ce-spin" role="progressbar" aria-label="Working" />

/** The branch name as a button that opens the branch picker for a repository. */
export function BranchChip({ store, repo, branch, className }: { store: EditorStore; repo: string; branch: string | null | undefined; className?: string }): ReactElement {
  return (
    <button
      className={className ?? 'ce-chip'} data-act="branch" data-repo={repo} title="Switch or create a branch"
      onClick={(e) => { e.stopPropagation(); void store.gitTools.openPicker(repo) }}
    >
      <BranchGlyph /><span>{branch ?? 'detached HEAD'}</span>
    </button>
  )
}

// ---- sync + commit (CHANGES) ----------------------------------------------------------------------------------------

function SyncBar({ store, repo, g }: { store: EditorStore; repo: string; g: GitState | undefined }): ReactElement {
  const t = useGitTools(store)
  const sync = t.sync[repo]
  const busy = sync?.busy ?? null
  const st = g?.status
  const label = busy === 'fetch' ? 'Fetching...' : busy === 'pull' ? 'Pulling...' : busy === 'push' ? 'Pushing...' : null
  const run = (kind: 'fetch' | 'pull' | 'push') => (): void => { void store.gitTools.sync(repo, kind) }
  return (
    <div className="ce-sync" data-repo-tools={repo}>
      <div className="ce-sync-row">
        <BranchChip store={store} repo={repo} branch={st?.branch} />
        {st && (st.ahead > 0 || st.behind > 0) ? <span className="ce-ab" title={`${st.ahead} to push, ${st.behind} to pull`} data-ab>{`↑${st.ahead} ↓${st.behind}`}</span> : null}
        <span className="ce-grow" />
        <button className="ce-ibtn ce-tbtn" data-act="fetch" disabled={busy !== null} title="Fetch from the remotes" onClick={run('fetch')}>Fetch</button>
        <button className="ce-ibtn ce-tbtn" data-act="pull" disabled={busy !== null} title="Pull (fast-forward only)" onClick={run('pull')}>Pull{st && st.behind > 0 ? ` ${st.behind}` : ''}</button>
        <button className="ce-ibtn ce-tbtn" data-act="push" disabled={busy !== null} title="Push" onClick={run('push')}>Push{st && st.ahead > 0 ? ` ${st.ahead}` : ''}</button>
      </div>
      {label ? <div className="ce-sync-msg" data-busy="true" role="status"><Spinner />{label}</div> : null}
      {sync?.error ? <div className="ce-sync-msg" data-error="true" role="alert">{sync.error}</div> : null}
      {sync?.info && !sync.error ? <div className="ce-sync-msg" data-info="true">{sync.info}</div> : null}
    </div>
  )
}

function CommitBox({ store, repo, g }: { store: EditorStore; repo: string; g: GitState | undefined }): ReactElement {
  const t = useGitTools(store)
  const d = store.gitTools.draft(repo)
  const groups = useMemo(() => groupChanges(g?.status), [g?.status])
  const staged = groups.staged.length
  const tracked = groups.changes.length
  const long = subjectTooLong(d.message)
  const first = (d.message.split('\n')[0] ?? '').length
  const all = staged === 0 && !d.amend
  const label = d.busy ? 'Committing...' : d.amend ? 'Amend' : all && tracked > 0 ? `Commit all tracked (${tracked})` : staged > 0 ? `Commit (${staged})` : 'Commit'
  const disabled = d.busy || (d.message.trim() === '' && !d.amend)
  void t
  return (
    <div className="ce-commit" data-commit-box={repo}>
      <textarea
        className="ce-msg" rows={3} aria-label="Commit message" placeholder="Message (Ctrl+Enter to commit)" value={d.message} disabled={d.busy}
        onChange={(e) => store.gitTools.setMessage(repo, e.target.value)}
        onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void store.gitTools.commit(repo) } }}
      />
      <div className="ce-commit-row">
        <label className="ce-check" title="Replace the last commit">
          <input type="checkbox" data-act="amend" checked={d.amend} disabled={d.busy} onChange={(e) => void store.gitTools.setAmend(repo, e.target.checked)} />
          Amend last commit
        </label>
        <span className="ce-grow" />
        <span className="ce-hint" data-long={long} title={`The first line is usually kept to ${SUBJECT_HINT} characters`}>{first > 0 ? `${first}/${SUBJECT_HINT}` : ''}</span>
      </div>
      {d.amend && d.pushed ? <div className="ce-sync-msg" data-warn="true" role="alert">The last commit is already on the upstream branch. Amending rewrites shared history.</div> : null}
      <button className="ce-btn" data-act="commit" data-primary="true" disabled={disabled} onClick={() => void store.gitTools.commit(repo)} title={all && tracked > 0 ? 'Nothing is staged: commits all modified tracked files after a confirmation' : 'Commit the staged changes'}>
        {d.busy ? <Spinner /> : null}{label}
      </button>
      {d.error ? <div className="ce-sync-msg" data-error="true" role="alert">{d.error}</div> : null}
    </div>
  )
}

/** Sync bar + commit box of one repository, shown above its change groups. */
export function RepoTools({ store, repo, g }: { store: EditorStore; repo: string; g: GitState | undefined }): ReactElement | null {
  if (!g || g.notGit) return null
  return (
    <div className="ce-tools">
      <SyncBar store={store} repo={repo} g={g} />
      <CommitBox store={store} repo={repo} g={g} />
    </div>
  )
}

// ---- branch picker ----------------------------------------------------------------------------------------------------

export function BranchPicker({ store }: { store: EditorStore }): ReactElement | null {
  const t = useGitTools(store)
  const p = t.picker
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  useEffect(() => { setQuery(''); setSel(0) }, [p?.repo])
  const info = p?.info ?? null
  const q = query.trim()
  const items = useMemo(() => {
    const out: Array<{ kind: 'create' | 'local' | 'remote'; name: string; label: string; note?: string; current?: boolean }> = []
    if (info === null) return out
    const needle = q.toLowerCase()
    if (q !== '' && !info.local.some((b) => b.name === q)) out.push({ kind: 'create', name: q, label: `Create branch "${q}" from HEAD` })
    for (const b of info.local) if (b.name.toLowerCase().includes(needle)) out.push({ kind: 'local', name: b.name, label: b.name, note: b.upstream ?? undefined, current: b.current })
    for (const r of info.remote) if (!r.local && r.name.toLowerCase().includes(needle)) out.push({ kind: 'remote', name: r.name, label: r.name, note: 'check out as tracking branch' })
    return out
  }, [info, q])
  if (p === null) return null
  const close = (): void => store.gitTools.closePicker()
  const choose = (i: number): void => {
    const it = items[i]
    if (!it || it.current) return
    void store.gitTools.checkout(p.repo, it.name, it.kind === 'create')
  }
  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(items.length - 1, sel + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel) }
  }
  const repoName = store.getState().repos.list?.find((r) => r.rel === p.repo)?.name ?? baseName(store.repoPath(p.repo) ?? '')
  return (
    <div className="ce-qo-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="ce-qo ce-bp" data-branch-picker role="dialog" aria-label="Branches">
        <div className="ce-bp-h">Branches <span className="ce-dim">{repoName}</span></div>
        <input autoFocus placeholder="Filter, or type a new branch name" aria-label="Branch" value={query} disabled={p.busy} onChange={(e) => { setQuery(e.target.value); setSel(0) }} onKeyDown={onKey} />
        <div className="ce-qo-list" role="listbox">
          {p.loading ? <div className="ce-qo-note">Loading branches...</div> : null}
          {info?.detached ? <div className="ce-qo-note">HEAD is detached{info.head ? ` at ${info.head}` : ''}.</div> : null}
          {!p.loading && info !== null && items.length === 0 ? <div className="ce-qo-note">No matching branches.</div> : null}
          {items.map((it, i) => (
            <div
              key={`${it.kind}:${it.name}`} className="ce-qo-item" role="option" aria-selected={i === sel} data-sel={i === sel} data-kind={it.kind} data-branch={it.name} data-current={it.current === true}
              onMouseEnter={() => setSel(i)} onClick={() => choose(i)}
            >
              {it.kind === 'create' ? <span className="ce-plus">+</span> : <BranchGlyph />}
              <span>{it.label}{it.current ? ' (current)' : ''}</span>
              {it.note ? <span className="ce-dim">{it.note}</span> : null}
            </div>
          ))}
        </div>
        {p.busy ? <div className="ce-sync-msg" data-busy="true" role="status"><Spinner />Switching...</div> : null}
        {p.error ? <div className="ce-sync-msg" data-error="true" role="alert">{p.error}</div> : null}
        <div className="ce-qo-note">Uncommitted changes stay in place. If a switch would overwrite them, git refuses and nothing is stashed.</div>
      </div>
    </div>
  )
}

// ---- history ------------------------------------------------------------------------------------------------------------

function CommitFiles({ store, files, truncated }: { store: EditorStore; files: CommitFile[]; truncated: boolean }): ReactElement {
  return (
    <div className="ce-hfiles">
      {files.map((f) => (
        <div key={`${f.status}:${f.path}`} className="ce-row" data-path={f.path} title={f.origPath ? `${f.origPath} -> ${f.path}` : f.path} onClick={() => void store.gitTools.openCommitFile(f)}>
          <FileIcon name={f.path} />
          <span className="ce-name">{baseName(f.path)}</span>
          {f.path.includes('/') ? <span className="ce-dim">{f.path.slice(0, f.path.lastIndexOf('/'))}</span> : null}
          <span className="ce-hbadge" data-k={f.status}>{f.status}</span>
        </div>
      ))}
      {truncated ? <div className="ce-note">Only the first {files.length} files are listed.</div> : null}
    </div>
  )
}

export function HistoryBody({ store }: { store: EditorStore }): ReactElement {
  const t = useGitTools(store)
  const h = t.history
  const repos = store.getState().repos.list ?? []
  if (store.getState().root === null) return <div className="ce-note">Pick a folder above.</div>
  if (repos.length === 0) return <div className="ce-note">No git repository in this folder.</div>
  return (
    <div data-history>
      {repos.length > 1 ? (
        <div className="ce-hbar">
          <select className="ce-select" aria-label="Repository" value={h.repo} onChange={(e) => void store.gitTools.setHistoryRepo(e.target.value)}>
            {repos.map((r) => <option key={r.rel} value={r.rel}>{r.name}</option>)}
          </select>
        </div>
      ) : null}
      {h.path !== '' ? (
        <div className="ce-hbar"><span className="ce-chip" data-file-filter title={h.path}>History of {baseName(h.path)}</span><button className="ce-ibtn" aria-label="Show the whole history" title="Show the whole history" onClick={() => void store.gitTools.clearFileFilter()}>&times;</button></div>
      ) : null}
      {h.error ? <div className="ce-note" data-error="true">{h.error}</div> : null}
      {h.commits.map((c) => {
        const open = h.selected === c.hash
        return (
          <div key={c.hash} className="ce-hc" data-commit={c.hash} data-open={open}>
            <div className="ce-hrow" role="button" aria-expanded={open} tabIndex={0} onClick={() => void store.gitTools.selectCommit(c.hash)} onKeyDown={(e) => { if (e.key === 'Enter') void store.gitTools.selectCommit(c.hash) }} title={`${c.hash}\n${c.author} <${c.email}>`}>
              <div className="ce-hsub">
                <span className="ce-hs">{c.subject || '(no message)'}</span>
                {c.refs.map((r) => <span key={r} className="ce-ref" data-tag={r.startsWith('tag: ')}>{r.replace(/^tag: /, '')}</span>)}
              </div>
              <div className="ce-hmeta"><code>{c.short}</code><span>{c.author}</span><span title={new Date(c.date).toLocaleString()}>{relativeDate(c.date)}</span></div>
            </div>
            {open ? (
              <div className="ce-hdetail">
                {h.detailLoading ? <div className="ce-note">Loading...</div> : null}
                {h.detailError ? <div className="ce-note" data-error="true">{h.detailError}</div> : null}
                {h.detail && h.detail.hash === c.hash ? (
                  <>
                    {h.detail.message.includes('\n') ? <pre className="ce-hmsg">{h.detail.message.slice(h.detail.message.indexOf('\n') + 1).trim()}</pre> : null}
                    {h.detail.files.length === 0 ? <div className="ce-note">No file changes.</div> : <CommitFiles store={store} files={h.detail.files} truncated={h.detail.truncated} />}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
      {h.loading ? <div className="ce-note" data-busy="true"><Spinner />Loading...</div> : null}
      {!h.loading && h.commits.length === 0 && !h.error ? <div className="ce-note">No commits yet.</div> : null}
      {h.hasMore && !h.loading ? <div className="ce-more"><button className="ce-btn" data-act="more-history" onClick={() => void store.gitTools.loadHistory()}>Load more</button></div> : null}
    </div>
  )
}
