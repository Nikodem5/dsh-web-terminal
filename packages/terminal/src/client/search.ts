// dsh-web-terminal — find-in-terminal: drives xterm's search addon for the open find bar.

import { emit, runtimes, store } from './state.ts'

export interface FindOptions {
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
}

const FIND_DECORATIONS = {
  matchBackground: '#6b5c1f',
  matchBorder: '#9c8a2e',
  matchOverviewRuler: '#d1b84a',
  activeMatchBackground: '#c9a227',
  activeMatchBorder: '#ffd75e',
  activeMatchColorOverviewRuler: '#ffd75e',
}

/** Open the find bar on a terminal (Ctrl+F). */
export function openSearch(id: string): void {
  store.searchId = id
  emit()
}

/** Close the find bar, drop highlights and hand focus back to the terminal. */
export function closeSearch(): void {
  const rt = store.searchId === null ? undefined : runtimes.get(store.searchId)
  store.searchId = null
  if (rt !== undefined) {
    rt.search.clearDecorations()
    rt.searchIndex = 0
    rt.searchCount = 0
    rt.term.focus()
  }
  emit()
}

/**
 * Find the next/previous match of `query` in a terminal's buffer.
 * @param incremental - true while typing, so the current match stays put when it still matches.
 */
export function runSearch(id: string, query: string, options: FindOptions, direction: 'next' | 'prev', incremental = false): void {
  const rt = runtimes.get(id)
  if (rt === undefined) return
  if (query.length === 0) {
    rt.search.clearDecorations()
    rt.searchIndex = 0
    rt.searchCount = 0
    emit()
    return
  }
  const opts = { ...options, incremental, decorations: FIND_DECORATIONS }
  try {
    if (direction === 'next') rt.search.findNext(query, opts)
    else rt.search.findPrevious(query, opts)
  } catch {
    // An invalid regular expression simply finds nothing.
    rt.searchIndex = 0
    rt.searchCount = 0
    emit()
  }
}
