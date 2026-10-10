// dsh-code-editor - the Code page: sidebar (root picker, EXPLORER, CHANGES), tabs, editor, status bar, quick open.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { groupChanges, statusLetter, type GroupName } from './changes.ts'
import { flattenTree, workspaceChoices } from './explorer.ts'
import { rankFiles } from './fuzzy.ts'
import { baseName } from './paths.ts'
import { actionFor, describeTarget } from './shortcuts.ts'
import type { EditorStore, State, Tab } from './store.ts'
import { injectStyles } from './styles.ts'
import { getStore } from './instance.ts'
import { isDarkSurface } from './theme.ts'
import type { GitFile } from './types.ts'

function useStore(store: EditorStore): State {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}

const Chevron = ({ open }: { open: boolean }): ReactElement => (
  <span className="ce-chev" data-open={open}>
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 1.5L7 5L3.5 8.5" /></svg>
  </span>
)
const FileGlyph = (): ReactElement => (
  <svg className="ce-ficon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M4 1.8h5l3 3V14.2H4z" /><path d="M9 1.8v3h3" /></svg>
)
const FolderGlyph = (): ReactElement => (
  <svg className="ce-ficon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M1.8 4h4l1.4 1.6h7V13H1.8z" /></svg>
)

// ---- sidebar ------------------------------------------------------------------------------------------------

function RootPicker({ store, s, choices }: { store: EditorStore; s: State; choices: Array<{ label: string; path: string }> }): ReactElement {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const options = useMemo(() => {
    const seen = new Set(choices.map((c) => c.path.toLowerCase()))
    const extra = s.roots.filter((r) => !seen.has(r.path.toLowerCase())).map((r) => ({ label: baseName(r.path), path: r.path }))
    return [...choices, ...extra]
  }, [choices, s.roots])
  const known = s.root !== null && options.some((o) => o.path === s.root)
  const submit = (): void => {
    const p = text.trim()
    if (p.length === 0) return
    void store.openFolder(p).then((ok) => { if (ok) { setText(''); setAdding(false) } })
  }
  return (
    <div className="ce-roots">
      <div className="ce-roots-row">
        <select className="ce-select" aria-label="Folder" value={s.root ?? ''} onChange={(e) => void store.selectRoot(e.target.value)} title={s.root ?? ''}>
          {s.root === null || !known ? <option value={s.root ?? ''}>{s.root === null ? 'Select a folder' : s.root}</option> : null}
          {options.map((o) => <option key={o.path} value={o.path}>{o.label}</option>)}
        </select>
        <button className="ce-btn" onClick={() => setAdding(!adding)} title="Open a folder by its absolute path">Open folder...</button>
      </div>
      {adding ? (
        <input
          className="ce-input" autoFocus placeholder="Absolute folder path, Enter to open" value={text} aria-label="Folder path"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') setAdding(false) }}
        />
      ) : null}
    </div>
  )
}

function Section({ title, open, onToggle, count, actions, children }: {
  title: string; open: boolean; onToggle(): void; count?: number; actions?: ReactElement | null; children: ReactElement | ReactElement[] | null
}): ReactElement {
  return (
    <div className="ce-sec" data-open={open} data-sec={title}>
      <div className="ce-sec-h" onClick={onToggle} role="button" aria-expanded={open}>
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
              <Chevron open={r.expanded} /><FolderGlyph /><span className="ce-name">{r.name}</span>
            </div>
          )
        }
        return (
          <div key={r.path} className="ce-row" style={{ ...pad, paddingLeft: pad.paddingLeft + 14 }} role="treeitem" data-path={r.path} data-active={activePath === r.path} onClick={() => void store.openFile(r.path)}>
            <FileGlyph /><span className="ce-name">{r.name}</span>
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

function ChangeRow({ store, f, group }: { store: EditorStore; f: GitFile; group: GroupName }): ReactElement {
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
  const id = group === 'untracked' ? `file:${f.path}` : `diff:${group === 'staged' ? 's' : 'w'}:${f.path}`
  const open = (): void => { if (group === 'untracked') void store.openFile(f.path); else void store.openDiff(f.path, group === 'staged') }
  const stop = (fn: () => void) => (e: { stopPropagation(): void }): void => { e.stopPropagation(); fn() }
  return (
    <div className="ce-row" data-path={f.path} data-group={group} data-active={store.getState().active === id} onClick={open} title={f.origPath ? `${f.origPath} -> ${f.path}` : f.path}>
      <span style={{ width: 8 }} />
      <span className="ce-name">{baseName(f.path)}</span>
      {dir ? <span className="ce-dim">{dir}</span> : null}
      <span className="ce-acts">
        {group !== 'staged' ? <button className="ce-ibtn" data-act="discard" data-danger="true" title={group === 'untracked' ? 'Delete file' : 'Discard changes'} onClick={stop(() => void store.discard([f]))}>&#x21B6;</button> : null}
        {group === 'staged'
          ? <button className="ce-ibtn" data-act="unstage" title="Unstage" onClick={stop(() => void store.unstage([f.path]))}>&minus;</button>
          : <button className="ce-ibtn" data-act="stage" title="Stage" onClick={stop(() => void store.stage([f.path]))}>+</button>}
      </span>
      <span className="ce-badge" data-k={statusLetter(f, group)}>{statusLetter(f, group)}</span>
    </div>
  )
}

function Changes({ store, s }: { store: EditorStore; s: State }): ReactElement {
  const groups = useMemo(() => groupChanges(s.git.status), [s.git.status])
  if (s.root === null) return <div className="ce-note">Pick a folder above.</div>
  if (s.git.notGit) return <div className="ce-note">This folder is not a git repository.</div>
  if (s.git.error) return <div className="ce-note" data-error="true">{s.git.error}</div>
  if (s.git.status === null) return <div className="ce-note">Loading...</div>
  const total = groups.staged.length + groups.changes.length + groups.untracked.length
  if (total === 0) return <div className="ce-note">No changes.</div>
  return (
    <div>
      {GROUPS.map(({ key, label }) => groups[key].length === 0 ? null : (
        <div key={key} data-group-block={key}>
          <div className="ce-grp">
            <span>{label} ({groups[key].length})</span>
            <span className="ce-grow" />
            {key === 'staged'
              ? <button className="ce-ibtn" data-act="unstage-all" title="Unstage all" onClick={() => void store.unstageAll()}>&minus;</button>
              : <button className="ce-ibtn" data-act="stage-all" title={key === 'untracked' ? 'Stage all untracked' : 'Stage all'} onClick={() => void (key === 'changes' ? store.stage(groups.changes.map((f) => f.path)) : store.stage(groups.untracked.map((f) => f.path)))}>+</button>}
            {key !== 'staged' ? <button className="ce-ibtn" data-act="discard-all" data-danger="true" title={key === 'untracked' ? 'Delete all untracked files' : 'Discard all changes'} onClick={() => void store.discard(groups[key])}>&#x21B6;</button> : null}
          </div>
          {groups[key].map((f) => <ChangeRow key={`${key}:${f.path}`} store={store} f={f} group={key} />)}
        </div>
      ))}
    </div>
  )
}

function Sidebar({ store, s, choices }: { store: EditorStore; s: State; choices: Array<{ label: string; path: string }> }): ReactElement {
  const [openEx, setOpenEx] = useState(true)
  const [openCh, setOpenCh] = useState(true)
  useEffect(() => { if (s.changesFocus > 0) setOpenCh(true) }, [s.changesFocus])
  const total = s.git.status ? s.git.status.files.length : 0
  return (
    <aside className="ce-side">
      <RootPicker store={store} s={s} choices={choices} />
      <Section title="EXPLORER" open={openEx} onToggle={() => setOpenEx(!openEx)}
        actions={<button className="ce-ibtn" title="Refresh" data-act="refresh-tree" onClick={() => void store.refreshExplorer()}>&#x21BB;</button>}>
        <Explorer store={store} s={s} />
      </Section>
      <Section title="CHANGES" open={openCh} onToggle={() => setOpenCh(!openCh)} count={total}
        actions={<button className="ce-ibtn" title="Refresh" data-act="refresh-git" onClick={() => void store.refreshGit()}>&#x21BB;</button>}>
        <Changes store={store} s={s} />
      </Section>
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
  let overlay: ReactElement | null = null
  if (!tab) {
    overlay = (
      <div className="ce-overlay" data-empty>
        <h3>Code</h3>
        <span>Open a file from the Explorer, or press <kbd>Ctrl</kbd>+<kbd>P</kbd> to search.</span>
        {s.root === null ? <span>Pick a folder to start.</span> : null}
      </div>
    )
  } else if (tab.error) {
    overlay = <div className="ce-overlay"><h3>Could not open {tab.title}</h3><span>{tab.error}</span><button className="ce-btn" onClick={() => { store.closeTab(tab.id, true); void (tab.kind === 'file' ? store.openFile(tab.path) : store.openDiff(tab.path, tab.staged)) }}>Retry</button></div>
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
  return (
    <div className="ce-status" data-statusbar>
      <span title={liveLabel}><span className="ce-live" data-s={s.live} />{st?.branch ?? (s.git.notGit ? 'no git' : '-')}</span>
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

  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.defaultPrevented) return
    const action = actionFor(e.nativeEvent, describeTarget(e.target))
    if (action === null) return
    e.preventDefault()
    e.stopPropagation()
    if (action === 'save') void store.save()
    else if (action === 'closeTab') store.closeActive()
    else store.setQuickOpen(!store.getState().quickOpen)
  }, [store])

  const tab = store.tab(s.active)
  return (
    <div className="ce-view" ref={viewRef} data-scheme={scheme} data-dsh-plugin="code-editor" onKeyDown={onKeyDown}>
      <div className="ce-cols">
        <Sidebar store={store} s={s} choices={choices} />
        <main className="ce-main">
          <TabBar store={store} s={s} />
          {tab ? <Crumb store={store} s={s} tab={tab} /> : null}
          {tab ? <ConflictBar store={store} tab={tab} /> : null}
          <EditorArea store={store} s={s} tab={tab} />
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
