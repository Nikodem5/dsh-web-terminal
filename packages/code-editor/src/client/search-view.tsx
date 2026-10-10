// dsh-code-editor - the SEARCH view of the sidebar (search in files): query box with match-case / whole-word / regex
// toggles, collapsible include / exclude fields, results grouped by file. Logic: search-state.ts.

import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { FileIcon } from './file-icon.tsx'
import { baseName, dirName } from './paths.ts'
import { splitPreview, type SearchState } from './search-state.ts'
import type { EditorStore } from './store.ts'

function useSearch(store: EditorStore): SearchState {
  return useSyncExternalStore(store.search.subscribe, store.search.getState, store.search.getState)
}

/** The Files / Search switch at the top of the sidebar. */
export function SideTabs({ store }: { store: EditorStore }): ReactElement {
  const s = useSearch(store)
  return (
    <div className="ce-sidetabs" role="tablist" aria-label="Sidebar view">
      <button role="tab" className="ce-sidetab" data-act="view-files" aria-selected={s.view === 'files'} data-on={s.view === 'files'} onClick={() => store.search.showFiles()} title="Explorer and changes">
        Files
      </button>
      <button role="tab" className="ce-sidetab" data-act="view-search" aria-selected={s.view === 'search'} data-on={s.view === 'search'} onClick={() => store.search.show()} title="Search in files (Ctrl+Shift+F)">
        Search{s.total > 0 ? <span className="ce-count">{s.total > 999 ? '999+' : s.total}</span> : null}
      </button>
    </div>
  )
}

function Toggle({ label, title, on, act, onClick }: { label: string; title: string; on: boolean; act: string; onClick(): void }): ReactElement {
  return <button className="ce-tgl" data-act={act} data-on={on} aria-pressed={on} title={title} onClick={onClick}>{label}</button>
}

function summary(s: SearchState): string {
  if (s.status === 'loading') return 'Searching...'
  if (s.status !== 'done') return ''
  if (s.total === 0) return 'No results.'
  const files = s.results.length
  return `${s.total}${s.truncated ? '+' : ''} result${s.total === 1 ? '' : 's'} in ${files}${s.truncated ? '+' : ''} file${files === 1 ? '' : 's'}`
}

export function SearchPanel({ store }: { store: EditorStore }): ReactElement {
  const s = useSearch(store)
  const input = useRef<HTMLInputElement | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const c = store.search

  useEffect(() => {
    if (s.focus === 0) return
    input.current?.focus()
    input.current?.select()
  }, [s.focus])

  useEffect(() => {
    list.current?.querySelector('[data-sel="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [s.sel])

  // Keys typed in the fields: arrows walk the results, Enter searches / opens the selected match, Escape returns to the editor.
  const onKey = (e: ReactKeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') return
    if (e.key === 'ArrowDown') { e.preventDefault(); void c.step(1, false) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); void c.step(-1, false) }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void c.enter() }
    else if (e.key === 'Escape') { e.preventDefault(); store.getHost()?.focus() }
  }

  return (
    <div className="ce-searchp" data-search-panel onKeyDown={onKey}>
      <div className="ce-sq">
        <div className="ce-sq-row">
          <input
            ref={input} className="ce-input ce-sq-in" placeholder="Search" aria-label="Search in files" value={s.query.q} spellCheck={false} autoComplete="off"
            onChange={(e) => c.setText({ q: e.target.value })}
          />
          <Toggle label="Aa" act="case" title="Match case" on={s.query.caseSensitive} onClick={() => c.setFlag('caseSensitive', !s.query.caseSensitive)} />
          <Toggle label="ab" act="word" title="Match whole word" on={s.query.word} onClick={() => c.setFlag('word', !s.query.word)} />
          <Toggle label=".*" act="regex" title="Use regular expression" on={s.query.regex} onClick={() => c.setFlag('regex', !s.query.regex)} />
          <Toggle label="..." act="filters" title="Files to include / exclude" on={s.showFilters} onClick={() => c.toggleFilters()} />
        </div>
        {s.showFilters ? (
          <div className="ce-sq-filters">
            <input className="ce-input" placeholder="Files to include (*.ts, src/**)" aria-label="Files to include" data-field="include" value={s.query.include} spellCheck={false} onChange={(e) => c.setText({ include: e.target.value })} />
            <input className="ce-input" placeholder="Files to exclude (*.test.ts, docs)" aria-label="Files to exclude" data-field="exclude" value={s.query.exclude} spellCheck={false} onChange={(e) => c.setText({ exclude: e.target.value })} />
          </div>
        ) : null}
      </div>
      <div className="ce-sq-sum" role="status" data-search-summary>
        {summary(s)}
        {s.status === 'done' && s.truncated && !s.timedOut ? <span className="ce-dim"> (limited, refine the query)</span> : null}
        {s.timedOut ? <span className="ce-dim"> (timed out, results may be incomplete)</span> : null}
      </div>
      {s.status === 'error' ? <div className="ce-note" data-error="true" role="alert">{s.error}</div> : null}
      <div className="ce-sres" ref={list} role="tree" aria-label="Search results">
        {s.results.map((f) => {
          const closed = s.collapsed.includes(f.path)
          const dir = dirName(f.path)
          return (
            <div key={f.path} className="ce-sfile" data-path={f.path}>
              <div className="ce-row ce-sfile-h" role="treeitem" aria-expanded={!closed} onClick={() => c.toggleFile(f.path)} title={f.path}>
                <span className="ce-chev" data-open={!closed}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 1.5L7 5L3.5 8.5" /></svg>
                </span>
                <FileIcon name={f.path} />
                <span className="ce-name">{baseName(f.path)}</span>
                {dir ? <span className="ce-dim">{dir}</span> : null}
                <span className="ce-count ce-count-dim">{f.matches.length}</span>
              </div>
              {closed ? null : f.matches.map((m, i) => {
                const p = splitPreview(m)
                const sel = s.sel?.path === f.path && s.sel.index === i
                return (
                  <div key={`${m.line}:${m.col}:${i}`} className="ce-smatch" role="treeitem" data-sel={sel} data-line={m.line} title={`${f.path}:${m.line}:${m.col}`} onClick={() => void c.openMatch(f.path, i)}>
                    <span className="ce-ln">{m.line}</span>
                    <span className="ce-prev">{p.before}<mark>{p.hit}</mark>{p.after}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
