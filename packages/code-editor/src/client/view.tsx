// dsh-code-editor - the Code page: sidebar (root picker, search, EXPLORER, CHANGES), tabs, editor, status bar, quick open.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import { groupChanges, statusLetter, type GroupName } from './changes.ts'
import { flattenTree, workspaceChoices } from './explorer.ts'
import { FileIcon, FolderIcon } from './file-icon.tsx'
import { rankFiles } from './fuzzy.ts'
import { baseName, joinRel, sameRoot } from './paths.ts'
import { FRAC_DEFAULT, FRAC_MAX, FRAC_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './persist.ts'
import { pageAction } from './shortcuts.ts'
import type { EditorStore, GitState, State, Tab } from './store.ts'
import { injectStyles } from './styles.ts'
import { getStore } from './instance.ts'
import { isDarkSurface } from './theme.ts'
import { MdModeButtons, MdWork, canPreview } from './md-view.tsx'
import { SearchPanel, SideTabs } from './search-view.tsx'
import type { GitFile, RepoEntry } from './types.ts'

function useStore(store: EditorStore): State {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

const Chevron = ({ open }: { open: boolean }): ReactElement => (
  <span className="ce-chev" data-open={open}>
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 1.5L7 5L3.5 8.5" /></svg>
  </span>
)
const SearchGlyph = (): ReactElement => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.3" /><path d="M10 10l4 4" /></svg>
)

/** Total changed entries over every shown repository. */
function totalChanges(s: State): number {
  let n = s.git.status?.files.length ?? 0
  for (const g of Object.values(s.repoGit)) n += g.status?.files.length ?? 0
  return n
}

// ---- splitters ----------------------------------------------------------------------------------------------

/**
 * A draggable separator. `onMove` gets the pointer position (clientX for a vertical bar, clientY for a horizontal one)
 * while dragging; arrow keys call `onNudge(+1 | -1)`; a double click calls `onReset`.
 */
function Splitter({ vertical, label, value, min, max, onMove, onNudge, onReset }: {
  vertical: boolean; label: string; value: number; min: number; max: number
  onMove(pos: number): void; onNudge(dir: 1 | -1): void; onReset(): void
}): ReactElement {
  const [drag, setDrag] = useState(false)
  const start = (e: ReactMouseEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    setDrag(true)
    const move = (ev: MouseEvent): void => onMove(vertical ? ev.clientX : ev.clientY)
    const up = (): void => {
      setDrag(false)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  const key = (e: ReactKeyboardEvent): void => {
    const back = vertical ? 'ArrowLeft' : 'ArrowUp'
    const fwd = vertical ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back) { e.preventDefault(); onNudge(-1) }
    else if (e.key === fwd) { e.preventDefault(); onNudge(1) }
    else if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); onReset() }
  }
  return (
    <div
      className={vertical ? 'ce-split ce-split-v' : 'ce-split ce-split-h'} role="separator" tabIndex={0} data-drag={drag} data-split={vertical ? 'sidebar' : 'sections'}
      aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-label={label} aria-valuenow={Math.round(value * 100) / 100} aria-valuemin={min} aria-valuemax={max}
      title={`${label} (drag, double-click to reset)`}
      onMouseDown={start} onDoubleClick={onReset} onKeyDown={key}
    />
  )
}

// ---- sidebar ------------------------------------------------------------------------------------------------

function RootPicker({ store, s, choices }: { store: EditorStore; s: State; choices: Array<{ label: string; path: string }> }): ReactElement {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const options = useMemo(() => {
    const seen = new Set(choices.map((c) => c.path.toLowerCase()))
    const all = [...choices.map((c) => c.path), ...s.roots.map((r) => r.path)]
    // Repositories found below a folder are registered as roots too; only list a nested root the user opened by hand.
    const nested = (p: string): boolean => all.some((o) => !sameRoot(o, p) && p.replace(/\\/g, '/').toLowerCase().startsWith(`${o.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}/`))
    const extra = s.roots
      .filter((r) => !seen.has(r.path.toLowerCase()) && (!nested(r.path) || s.folders.some((f) => sameRoot(f, r.path))))
      .map((r) => ({ label: baseName(r.path), path: r.path }))
    return [...choices, ...extra]
  }, [choices, s.roots, s.folders])
  const known = s.root !== null && options.some((o) => o.path === s.root)
  const canBrowse = store.canBrowse()
  const submit = (): void => {
    const p = text.trim()
    if (p.length === 0) return
    void store.openFolder(p).then((ok) => { if (ok) { setText(''); setAdding(false) } })
  }
  return (
    <div className="ce-roots">
      <select className="ce-select" aria-label="Folder" value={s.root ?? ''} onChange={(e) => void store.selectRoot(e.target.value)} title={s.root ?? ''}>
        {s.root === null || !known ? <option value={s.root ?? ''}>{s.root === null ? 'Select a folder' : s.root}</option> : null}
        {options.map((o) => <option key={o.path} value={o.path}>{o.label}</option>)}
      </select>
      <div className="ce-roots-row">
        {canBrowse ? <button className="ce-btn" data-act="browse" onClick={() => void store.browse()} title="Choose a folder with the system dialog">Browse...</button> : null}
        <button className="ce-btn" data-act="type-path" onClick={() => setAdding(!adding)} title="Open a folder by typing its absolute path">{canBrowse ? 'Type path...' : 'Open folder...'}</button>
      </div>
      {adding ? (
        <input
          className="ce-input" autoFocus placeholder="Absolute folder path, Enter to open" value={text} aria-label="Folder path"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') setAdding(false) }}
        />
      ) : null}
      <button className="ce-search" data-act="quick-open" onClick={() => store.setQuickOpen(true)} title="Search files by name (Ctrl+E)">
        <SearchGlyph /><span>Search files</span><kbd>Ctrl+E</kbd>
      </button>
    </div>
  )
}

function Section({ title, open, onToggle, count, actions, style, children }: {
  title: string; open: boolean; onToggle(): void; count?: number; actions?: ReactElement | null; style?: Record<string, string | number>
  children: ReactElement | ReactElement[] | null
}): ReactElement {
  return (
    <div className="ce-sec" data-open={open} data-sec={title} style={style}>
      <div className="ce-sec-h" onClick={onToggle} role="button" aria-expanded={open} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}>
        <Chevron open={open} />
        <span>{title}</span>
        {count !== undefined && count > 0 ? <span className="ce-count">{count}</span> : null}
        <span className="ce-grow" />
        <span onClick={(e) => e.stopPropagation()}>{actions}</span>
      </div>
      {open ? <div className="ce-body">{children}</div> : null}
    </div>
  )
}

function Explorer({ store, s }: { store: EditorStore; s: State }): ReactElement {
  const rows = useMemo(() => flattenTree(s.tree, s.expanded), [s.tree, s.expanded])
  const activePath = store.tab(s.active)?.kind === 'file' ? store.tab(s.active)?.path : undefined
  if (s.root === null) return <div className="ce-note">Pick a folder above.</div>
  return (
    <div role="tree">
      {rows.map((r, i) => {
        const pad = { paddingLeft: 6 + r.depth * 12 }
        if (r.kind === 'note') return <div key={`n${i}`} className="ce-note" style={pad}>{r.text}</div>
        if (r.kind === 'dir') {
          return (
            <div key={r.path} className="ce-row" style={pad} role="treeitem" aria-expanded={r.expanded} data-path={r.path} onClick={() => void store.toggleDir(r.path)}>
              <Chevron open={r.expanded} /><FolderIcon open={r.expanded} /><span className="ce-name">{r.name}</span>
            </div>
          )
        }
        return (
          <div key={r.path} className="ce-row" style={{ ...pad, paddingLeft: pad.paddingLeft + 14 }} role="treeitem" data-path={r.path} data-active={activePath === r.path} onClick={() => void store.openFile(r.path)}>
            <FileIcon name={r.name} /><span className="ce-name">{r.name}</span>
          </div>
        )
      })}
    </div>
  )
}

const GROUPS: Array<{ key: GroupName; label: string }> = [
  { key: 'staged', label: 'Staged' },
  { key: 'changes', label: 'Changes' },
  { key: 'untracked', label: 'Untracked' },
]

/** One changed file. `repo` is the root-relative folder of its repository ('' = the root); `f.path` is relative to that repository. */
function ChangeRow({ store, f, group, repo }: { store: EditorStore; f: GitFile; group: GroupName; repo: string }): ReactElement {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  const full = joinRel(repo, f.path)
  const id = group === 'untracked' ? `file:${full}` : `diff:${group === 'staged' ? 's' : 'w'}:${full}`
  const open = (): void => { if (group === 'untracked') void store.openFile(full); else void store.openDiff(full, group === 'staged', repo) }
  const stop = (fn: () => void) => (e: { stopPropagation(): void }): void => { e.stopPropagation(); fn() }
  return (
    <div className="ce-row" data-path={f.path} data-group={group} data-active={store.getState().active === id} onClick={open} title={f.origPath ? `${f.origPath} -> ${f.path}` : f.path}>
      <FileIcon name={f.path} />
      <span className="ce-name">{baseName(f.path)}</span>
      {dir ? <span className="ce-dim">{dir}</span> : null}
      <span className="ce-acts">
        {group !== 'staged' ? <button className="ce-ibtn" data-act="discard" data-danger="true" title={group === 'untracked' ? 'Delete file' : 'Discard changes'} onClick={stop(() => void store.discard([f], repo))}>&#x21B6;</button> : null}
        {group === 'staged'
          ? <button className="ce-ibtn" data-act="unstage" title="Unstage" onClick={stop(() => void store.unstage([f.path], repo))}>&minus;</button>
          : <button className="ce-ibtn" data-act="stage" title="Stage" onClick={stop(() => void store.stage([f.path], repo))}>+</button>}
      </span>
      <span className="ce-badge" data-k={statusLetter(f, group)}>{statusLetter(f, group)}</span>
    </div>
  )
}

/** The Staged / Changes / Untracked groups of one repository. */
function RepoGroups({ store, g, repo }: { store: EditorStore; g: GitState; repo: string }): ReactElement {
  const groups = useMemo(() => groupChanges(g.status), [g.status])
  if (g.notGit) return <div className="ce-note">This folder is not a git repository.</div>
  if (g.error && g.status === null) return <div className="ce-note" data-error="true">{g.error}</div>
  if (g.status === null) return <div className="ce-note">Loading...</div>
  const total = groups.staged.length + groups.changes.length + groups.untracked.length
  if (total === 0) return <div className="ce-note">No changes.</div>
  return (
    <div>
      {g.error ? <div className="ce-note" data-error="true">{g.error}</div> : null}
      {GROUPS.map(({ key, label }) => groups[key].length === 0 ? null : (
        <div key={key} data-group-block={key}>
          <div className="ce-grp">
            <span>{label} ({groups[key].length})</span>
            <span className="ce-grow" />
            {key === 'staged'
              ? <button className="ce-ibtn" data-act="unstage-all" title="Unstage all" onClick={() => void store.unstageAll(repo)}>&minus;</button>
              : <button className="ce-ibtn" data-act="stage-all" title={key === 'untracked' ? 'Stage all untracked' : 'Stage all'} onClick={() => void (key === 'changes' ? store.stage(groups.changes.map((f) => f.path), repo) : store.stage(groups.untracked.map((f) => f.path), repo))}>+</button>}
            {key !== 'staged' ? <button className="ce-ibtn" data-act="discard-all" data-danger="true" title={key === 'untracked' ? 'Delete all untracked files' : 'Discard all changes'} onClick={() => void store.discard(groups[key], repo)}>&#x21B6;</button> : null}
          </div>
          {groups[key].map((f) => <ChangeRow key={`${key}:${f.path}`} store={store} f={f} group={key} repo={repo} />)}
        </div>
      ))}
    </div>
  )
}

/** A collapsible repository in the list shown when the root itself is not a repository. */
function RepoBlock({ store, repo, g, open, onToggle }: { store: EditorStore; repo: RepoEntry; g: GitState | undefined; open: boolean; onToggle(): void }): ReactElement {
  const n = g?.status?.files.length ?? 0
  return (
    <div className="ce-repo" data-repo={repo.rel} data-open={open}>
      <div className="ce-repo-h" role="button" aria-expanded={open} onClick={onToggle} title={repo.path}>
        <Chevron open={open} />
        <span className="ce-name">{repo.name}</span>
        {repo.rel !== repo.name ? <span className="ce-dim">{repo.rel}</span> : null}
        <span className="ce-grow" />
        {g?.status?.branch ? <span className="ce-branch" title="Branch">{g.status.branch}</span> : null}
        {n > 0 ? <span className="ce-count">{n}</span> : null}
        {g?.loading && g.status === null ? <span className="ce-dim">...</span> : null}
      </div>
      {open ? <div className="ce-repo-body">{g ? <RepoGroups store={store} g={g} repo={repo.rel} /> : <div className="ce-note">Loading...</div>}</div> : null}
    </div>
  )
}

function Changes({ store, s }: { store: EditorStore; s: State }): ReactElement {
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  if (s.root === null) return <div className="ce-note">Pick a folder above.</div>
  const list = s.repos.list
  if (list === null) return s.repos.error ? <div className="ce-note" data-error="true">{s.repos.error}</div> : <div className="ce-note">Loading...</div>
  if (list.length === 0) return <div className="ce-note" data-empty-repos>No git repository in this folder.</div>
  if (list.length === 1 && list[0].rel === '') return <RepoGroups store={store} g={s.git} repo="" />
  return (
    <div>
      {s.repos.truncated ? <div className="ce-note">Showing the first {list.length} repositories.</div> : null}
      {list.map((r) => {
        const g = s.repoGit[r.rel]
        const open = toggled[r.rel] ?? (g?.status !== null && g?.status !== undefined && g.status.files.length > 0)
        return <RepoBlock key={r.rel} store={store} repo={r} g={g} open={open} onToggle={() => setToggled({ ...toggled, [r.rel]: !open })} />
      })}
    </div>
  )
}

function Sidebar({ store, s, choices }: { store: EditorStore; s: State; choices: Array<{ label: string; path: string }> }): ReactElement {
  const { exOpen, chOpen, exFrac } = s.layout
  const secs = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (s.changesFocus > 0) store.setLayout({ chOpen: true }) }, [s.changesFocus, store])
  const total = totalChanges(s)
  const both = exOpen && chOpen
  const view = useSyncExternalStore(store.search.subscribe, () => store.search.getState().view, () => store.search.getState().view)
  const grow = (open: boolean, share: number): Record<string, number | string> => (open ? { flex: `${both ? share : 1} 1 0px` } : { flex: '0 0 auto' })
  const dragSections = (y: number): void => {
    const box = secs.current?.getBoundingClientRect()
    if (!box || box.height <= 0) return
    store.setLayout({ exFrac: (y - box.top) / box.height })
  }
  return (
    <aside className="ce-side" style={{ width: s.layout.sidebar }}>
      <RootPicker store={store} s={s} choices={choices} />
      <SideTabs store={store} />
      {view === 'search' ? <SearchPanel store={store} /> : null}
      <div className="ce-secs" ref={secs} hidden={view === 'search'}>
        <Section title="EXPLORER" open={exOpen} onToggle={() => store.setLayout({ exOpen: !exOpen })} style={grow(exOpen, exFrac)}
          actions={<button className="ce-ibtn" title="Refresh" data-act="refresh-tree" onClick={() => void store.refreshExplorer()}>&#x21BB;</button>}>
          <Explorer store={store} s={s} />
        </Section>
        {both ? (
          <Splitter vertical={false} label="Resize Explorer and Changes" value={exFrac} min={FRAC_MIN} max={FRAC_MAX}
            onMove={dragSections} onNudge={(d) => store.setLayout({ exFrac: exFrac + d * 0.04 })} onReset={() => store.setLayout({ exFrac: FRAC_DEFAULT })} />
        ) : null}
        <Section title="CHANGES" open={chOpen} onToggle={() => store.setLayout({ chOpen: !chOpen })} count={total} style={grow(chOpen, 1 - exFrac)}
          actions={<button className="ce-ibtn" title="Refresh (rescans for repositories)" data-act="refresh-git" onClick={() => void store.refreshGit(true)}>&#x21BB;</button>}>
          <Changes store={store} s={s} />
        </Section>
      </div>
    </aside>
  )
}

// ---- center -------------------------------------------------------------------------------------------------

function TabBar({ store, s }: { store: EditorStore; s: State }): ReactElement {
  return (
    <div className="ce-tabs" role="tablist">
      {s.tabs.map((t) => (
        <div
          key={t.id} className="ce-tab" role="tab" aria-selected={s.active === t.id} data-active={s.active === t.id} data-kind={t.kind} data-conflict={t.conflict !== null}
          data-dirty={t.dirty} title={t.path}
          onClick={() => void store.activate(t.id)}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); store.closeTab(t.id) } }}
        >
          <FileIcon name={t.path} />
          <span className="ce-ttl">{t.title}</span>
          {t.dirty ? <span className="ce-dot" title="Unsaved changes" /> : null}
          <button className="ce-x" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); store.closeTab(t.id) }}>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2L8 8M8 2L2 8" /></svg>
          </button>
        </div>
      ))}
    </div>
  )
}

function Crumb({ store, s, tab }: { store: EditorStore; s: State; tab: Tab }): ReactElement {
  const parts = tab.path.split('/')
  const rootName = s.root ? baseName(s.root) : ''
  return (
    <div className="ce-crumb">
      <span className="ce-path" title={tab.path}>
        <span>{rootName ? `${rootName} > ` : ''}{parts.slice(0, -1).map((p) => `${p} > `).join('')}<b>{parts[parts.length - 1]}</b></span>
      </span>
      {tab.kind === 'file' ? (
        <button className="ce-btn" data-act="save" disabled={!tab.dirty || tab.saving} onClick={() => void store.save(tab.id)} title="Save (Ctrl+S)">Save</button>
      ) : null}
      {tab.kind === 'diff' || tab.kind === 'compare' ? (
        <span className="ce-seg" role="group" aria-label="Diff layout">
          <button className="ce-btn" data-on={!s.inline} data-act="side" onClick={() => store.setInline(false)}>Side by side</button>
          <button className="ce-btn" data-on={s.inline} data-act="inline" onClick={() => store.setInline(true)}>Inline</button>
        </span>
      ) : null}
      {canPreview(tab) ? <MdModeButtons store={store} tab={tab} /> : null}
      {tab.kind === 'diff' ? <button className="ce-btn" data-act="open-file" onClick={() => void store.openFile(tab.path)}>Open file</button> : null}
      {tab.kind === 'compare' ? (
        <>
          <button className="ce-btn" data-act="keep-mine" data-primary="true" onClick={() => void store.resolveCompare(tab.id, 'mine')}>Keep mine (overwrite)</button>
          <button className="ce-btn" data-act="use-disk" onClick={() => void store.resolveCompare(tab.id, 'disk')}>Use disk version</button>
        </>
      ) : null}
    </div>
  )
}

function ConflictBar({ store, tab }: { store: EditorStore; tab: Tab }): ReactElement | null {
  if (tab.kind !== 'file' || tab.conflict === null) return null
  return (
    <div className="ce-conflict" role="alert" data-conflict-bar>
      <b>File changed on disk</b>
      <span className="ce-grow">{tab.conflict.deleted ? 'It was deleted. Overwrite to recreate it.' : 'You have unsaved edits. Choose which version to keep.'}</span>
      {tab.conflict.deleted ? null : <button className="ce-btn" data-act="reload" onClick={() => void store.reload(tab.id)}>Reload</button>}
      <button className="ce-btn" data-act="overwrite" onClick={() => void store.overwrite(tab.id)}>Overwrite</button>
      {tab.conflict.deleted ? null : <button className="ce-btn" data-act="compare" onClick={() => void store.compare(tab.id)}>Compare</button>}
    </div>
  )
}

function EditorArea({ store, s, tab }: { store: EditorStore; s: State; tab: Tab | undefined }): ReactElement {
  const holder = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = holder.current
    const host = store.getHost()
    if (!el || !host) return
    el.appendChild(host.element)
    host.layout()
    return () => { host.element.remove() }
  }, [store, s.hostReady])
  // The sidebar width changes the editor's box: Monaco has automaticLayout, other hosts get an explicit nudge.
  useEffect(() => { store.getHost()?.layout() }, [store, s.layout.sidebar])
  let overlay: ReactElement | null = null
  if (!tab) {
    overlay = (
      <div className="ce-overlay" data-empty>
        <h3>Code</h3>
        <span>Open a file from the Explorer, or press <kbd>Ctrl</kbd>+<kbd>E</kbd> to search.</span>
        {s.root === null ? <span>Pick a folder to start.</span> : null}
      </div>
    )
  } else if (tab.error) {
    overlay = <div className="ce-overlay"><h3>Could not open {tab.title}</h3><span>{tab.error}</span><button className="ce-btn" onClick={() => { store.closeTab(tab.id, true); void (tab.kind === 'file' ? store.openFile(tab.path) : store.openDiff(tab.path, tab.staged, tab.repo)) }}>Retry</button></div>
  } else if (!tab.loaded) {
    overlay = <div className="ce-overlay"><span>Loading...</span></div>
  } else if (tab.binary) {
    overlay = <div className="ce-overlay"><h3>{tab.title}</h3><span>Binary file: not shown.</span></div>
  } else if (tab.tooLarge) {
    overlay = <div className="ce-overlay"><h3>{tab.title}</h3><span>File is larger than 2 MiB: not shown.</span></div>
  } else if (!s.hostReady) {
    overlay = <div className="ce-overlay" data-starting><span>Starting the editor...</span></div>
  }
  return (
    <div className="ce-editor">
      <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
      {overlay}
    </div>
  )
}

// ---- quick open ---------------------------------------------------------------------------------------------------

function QuickOpen({ store, s }: { store: EditorStore; s: State }): ReactElement | null {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[] | null>(null)
  const [sel, setSel] = useState(0)
  useEffect(() => {
    if (!s.quickOpen) return
    setQuery('')
    setSel(0)
    setFiles(null)
    let live = true
    void store.ensureFiles().then((f) => { if (live) setFiles(f) })
    return () => { live = false }
  }, [s.quickOpen, store])
  const ranked = useMemo(() => rankFiles(query, files ?? [], 50, s.recent), [query, files, s.recent])
  if (!s.quickOpen) return null
  const close = (): void => store.setQuickOpen(false)
  const choose = (path: string | undefined): void => { if (path !== undefined) { close(); void store.openFile(path) } }
  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(ranked.length - 1, sel + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(ranked[sel]?.path) }
  }
  return (
    <div className="ce-qo-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="ce-qo" data-ce-quick role="dialog" aria-label="Quick open">
        <input autoFocus placeholder="Go to file..." value={query} onChange={(e) => { setQuery(e.target.value); setSel(0) }} onKeyDown={onKey} aria-label="Go to file" />
        <div className="ce-qo-list" role="listbox">
          {files === null ? <div className="ce-qo-note">Loading files...</div> : null}
          {files !== null && ranked.length === 0 ? <div className="ce-qo-note">No matching files.</div> : null}
          {ranked.map((r, i) => {
            const at = new Set(r.positions)
            const slash = r.path.lastIndexOf('/') + 1
            const part = (from: number, to: number): ReactElement[] => [...r.path.slice(from, to)].map((ch, k) => (at.has(from + k) ? <mark key={k}>{ch}</mark> : <span key={k}>{ch}</span>))
            return (
              <div key={r.path} className="ce-qo-item" role="option" aria-selected={i === sel} data-sel={i === sel} data-path={r.path} onMouseEnter={() => setSel(i)} onClick={() => choose(r.path)}>
                <FileIcon name={r.path} />
                <span>{part(slash, r.path.length)}</span>
                <span className="ce-dim">{slash > 0 ? part(0, slash - 1) : null}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---- status bar ---------------------------------------------------------------------------------------------------

function StatusBar({ s, tab }: { s: State; tab: Tab | undefined }): ReactElement {
  const st = s.git.status
  const liveLabel = s.live === 'live' ? 'Live updates on' : s.live === 'connecting' ? 'Connecting...' : 'Live updates off (reconnecting)'
  const nested = s.repos.list !== null && s.repos.list.length > 0 && !s.repos.list.some((r) => r.rel === '')
  const branch = st?.branch ?? (nested ? `${s.repos.list?.length} repositories` : s.git.notGit ? 'no git' : '-')
  return (
    <div className="ce-status" data-statusbar>
      <span title={liveLabel}><span className="ce-live" data-s={s.live} />{branch}</span>
      {st && (st.ahead > 0 || st.behind > 0) ? <span title="Ahead / behind upstream">{`↑${st.ahead} ↓${st.behind}`}</span> : null}
      <span title={s.root ?? ''}>{s.root ?? 'no folder'}</span>
      <span className="ce-grow" />
      {tab && tab.kind === 'file' && s.cursor ? <span data-cursor>{`Ln ${s.cursor.line}, Col ${s.cursor.col}`}</span> : null}
      {tab && tab.kind === 'file' ? <span data-eol>{tab.eol === 'crlf' ? 'CRLF' : 'LF'}</span> : null}
      {tab ? <span data-lang>{tab.language}</span> : null}
    </div>
  )
}

// ---- page ---------------------------------------------------------------------------------------------------------

export interface PageProps {
  store: EditorStore
  /** The shell's standard workspaces hook (`select` gets the snapshot). */
  useWorkspaces?: <T>(select: (snapshot: { items?: unknown }) => T) => T
}

/** The page body: everything except where the store comes from (tests pass their own). */
export function CodeEditorPage({ store, useWorkspaces }: PageProps): ReactElement {
  const s = useStore(store)
  const items = useWorkspaces?.((snap) => snap.items)
  const choices = useMemo(() => workspaceChoices(items), [items])
  const key = choices.map((c) => c.path).join('\n')
  const viewRef = useRef<HTMLDivElement | null>(null)
  const [scheme, setScheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => { injectStyles() }, [])
  useEffect(() => { void store.setWorkspaces(choices.map((c) => c.path)) }, [key, store]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void store.ensureHost() }, [store])

  useLayoutEffect(() => {
    const measure = (): void => {
      const dark = isDarkSurface()
      setScheme(dark ? 'dark' : 'light')
      store.setDark(dark)
    }
    measure()
    const observer = new MutationObserver(measure)
    observer.observe(document.documentElement, { attributes: true })
    observer.observe(document.body, { attributes: true })
    return () => observer.disconnect()
  }, [store])

  // Shortcuts live on the WINDOW in the capture phase, not on the view: with the focus on the page body (right after
  // choosing "Code" in the sidebar) a key never passes through the view, and the desktop app / browser would take
  // it (print, save page). Capture + stopImmediatePropagation also keeps Monaco and the shell from seeing it twice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = pageAction(e, viewRef.current)
      if (action === null) return
      // F4 / Shift+F4 only mean something while there are search results.
      if ((action === 'searchNext' || action === 'searchPrev') && store.search.visible().length === 0) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (action === 'save') void store.save()
      else if (action === 'closeTab') store.closeActive()
      else if (action === 'searchFiles' || action === 'searchNext' || action === 'searchPrev') store.searchKey(action)
      else store.setQuickOpen(!store.getState().quickOpen)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [store])

  const dragSidebar = (x: number): void => {
    const box = viewRef.current?.getBoundingClientRect()
    const room = box && box.width > 0 ? box.width - 320 : SIDEBAR_MAX // always leave the editor some space
    store.setLayout({ sidebar: Math.min(x - (box?.left ?? 0), Math.max(SIDEBAR_MIN, room)) })
  }

  const tab = store.tab(s.active)
  return (
    <div className="ce-view" ref={viewRef} data-scheme={scheme} data-dsh-plugin="code-editor">
      <div className="ce-cols">
        <Sidebar store={store} s={s} choices={choices} />
        <Splitter vertical label="Resize sidebar" value={s.layout.sidebar} min={SIDEBAR_MIN} max={SIDEBAR_MAX}
          onMove={dragSidebar} onNudge={(d) => store.setLayout({ sidebar: s.layout.sidebar + d * 16 })} onReset={() => store.setLayout({ sidebar: SIDEBAR_DEFAULT })} />
        <main className="ce-main">
          <TabBar store={store} s={s} />
          {tab ? <Crumb store={store} s={s} tab={tab} /> : null}
          {tab ? <ConflictBar store={store} tab={tab} /> : null}
          <MdWork store={store} s={s} tab={tab}><EditorArea store={store} s={s} tab={tab} /></MdWork>
        </main>
      </div>
      <StatusBar s={s} tab={tab} />
      <QuickOpen store={store} s={s} />
      {s.notice ? (
        <div className="ce-notice" role="status" data-level={s.notice.level}>
          <span>{s.notice.text}</span>
          <button className="ce-ibtn" aria-label="Dismiss" onClick={() => store.dismissNotice()}>&times;</button>
        </div>
      ) : null}
    </div>
  )
}

/** The `main` entry: the shell passes its standard hooks (`useWorkspaces`...) as props. */
export function CodeEditorView(props: Omit<PageProps, 'store'>): ReactElement {
  return <CodeEditorPage {...props} store={getStore()} />
}
