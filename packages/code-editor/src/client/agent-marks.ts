// dsh-code-editor - "changed by agent" marks: files a Claude session in an open terminal edited.
//
// The Terminals plugin publishes `window.__dshTerminals = { version: 1, listEdits(), subscribe(cb) }` and fires a
// `dsh-terminals:edits` window event on change (contract: packages/terminal/README.md). This module reads it, maps the
// absolute paths into the open root, and hands the views a small immutable snapshot. No DOM, no React.
//
// The marks are temporary by construction: the terminal drops its entries when it closes, and the next refresh drops the mark.

import { isWindowsPath, relativeTo } from './paths.ts'

/** One terminal's edit list, as `listEdits()` returns it. */
export interface TerminalEditsLike {
  terminalId: string
  name: string
  color?: string
  live?: boolean
  files: Array<{ path: string; at: number; tool: string }>
}

export interface DshTerminalsLike {
  version?: number
  listEdits(): TerminalEditsLike[]
  subscribe(callback: () => void): () => void
}

/** Who changed a file, and when. */
export interface MarkEntry {
  terminalId: string
  name: string
  color?: string
  at: number
  tool: string
}

export interface AgentMarks {
  root: string | null
  /** Root-relative lookup key of a changed file -> the terminals that changed it (newest first). */
  files: ReadonlyMap<string, readonly MarkEntry[]>
  /** Lookup keys of every folder above a changed file. */
  dirs: ReadonlySet<string>
}

export const EMPTY_MARKS: AgentMarks = { root: null, files: new Map(), dirs: new Set() }

/** Event the Terminals plugin dispatches on `window` when the edits change. */
export const EDITS_EVENT = 'dsh-terminals:edits'

/** Lookup key of a root-relative path: forward slashes, lower-cased when the root is a Windows path (case-insensitive disk). */
export const markKey = (root: string, rel: string): string => {
  const s = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return isWindowsPath(root) ? s.toLowerCase() : s
}

/** A terminal's path in the root's flavour: Git Bash style `/c/Users/x` becomes `c:/Users/x` for a Windows root. */
function nativeFor(root: string, abs: string): string {
  const m = isWindowsPath(root) ? /^\/([A-Za-z])(?:\/(.*))?$/.exec(abs) : null
  return m === null ? abs : `${m[1]}:/${m[2] ?? ''}`
}

/** Map every terminal's edits into `root`. Files outside the root are ignored. */
export function buildMarks(root: string | null, terminals: readonly TerminalEditsLike[]): AgentMarks {
  if (root === null || root === '') return EMPTY_MARKS
  const files = new Map<string, MarkEntry[]>()
  const dirs = new Set<string>()
  for (const t of terminals) {
    for (const f of t.files ?? []) {
      if (typeof f?.path !== 'string') continue
      const rel = relativeTo(root, nativeFor(root, f.path))
      if (rel === null || rel === '') continue
      const key = markKey(root, rel)
      const list = files.get(key) ?? []
      list.push({ terminalId: t.terminalId, name: t.name, ...(t.color ? { color: t.color } : {}), at: f.at, tool: f.tool })
      files.set(key, list)
      for (let i = key.lastIndexOf('/'); i > 0; i = key.lastIndexOf('/', i - 1)) dirs.add(key.slice(0, i))
    }
  }
  for (const list of files.values()) list.sort((a, b) => b.at - a.at)
  return files.size === 0 ? { ...EMPTY_MARKS, root } : { root, files, dirs }
}

/** Who changed this root-relative file (undefined when nobody did). */
export const markFor = (marks: AgentMarks, rel: string): readonly MarkEntry[] | undefined =>
  marks.root === null ? undefined : marks.files.get(markKey(marks.root, rel))

/** Whether a changed file lives somewhere below this root-relative folder. */
export const dirMarked = (marks: AgentMarks, rel: string): boolean => marks.root !== null && marks.dirs.has(markKey(marks.root, rel))

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** Hover text: "Changed by Claude · api · 14:32 (Edit)", one line per terminal. */
export function markTitle(entries: readonly MarkEntry[], format: (at: number) => string = clock): string {
  return entries.map((e) => `Changed by Claude · ${e.name} · ${format(e.at)}${e.tool ? ` (${e.tool})` : ''}`).join('\n')
}

const POLL_MS = 2000

export interface AgentMarkSource {
  /** The folder the editor shows (marks are mapped into it). */
  setRoot(root: string | null): void
  get(): AgentMarks
  /** Start listening on the first subscriber, stop on the last. */
  subscribe(callback: () => void): () => void
}

/**
 * The live marks. Listens for the Terminals plugin's event and its subscribe API, and polls for the API while it has not
 * loaded yet (plugins load in any order). `win` is injectable for tests.
 */
export function createAgentMarkSource(win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): AgentMarkSource {
  let root: string | null = null
  let marks: AgentMarks = EMPTY_MARKS
  let signature = ''
  const listeners = new Set<() => void>()
  let unsubscribeApi: (() => void) | undefined
  let apiFor: unknown
  let timer: ReturnType<typeof setInterval> | undefined

  const api = (): DshTerminalsLike | undefined => {
    const a = (win as unknown as { __dshTerminals?: DshTerminalsLike }).__dshTerminals
    return a !== undefined && a !== null && typeof a.listEdits === 'function' ? a : undefined
  }

  const refresh = (): void => {
    let terminals: TerminalEditsLike[] = []
    try { terminals = api()?.listEdits() ?? [] } catch { terminals = [] }
    const next = buildMarks(root, terminals)
    const sig = `${root ?? ''}\u0000${[...next.files].map(([k, v]) => `${k}=${v.map((e) => `${e.terminalId}@${e.at}:${e.tool}:${e.name}`).join(',')}`).join('|')}`
    if (sig === signature) return
    signature = sig
    marks = next
    for (const l of [...listeners]) l()
  }

  /** Hook up the subscribe API once it exists (or re-hook if the plugin was reloaded). */
  const attach = (): void => {
    const a = api()
    if (a === undefined || a === apiFor) return
    unsubscribeApi?.()
    apiFor = a
    try { unsubscribeApi = a.subscribe(refresh) } catch { unsubscribeApi = undefined }
    refresh()
  }

  const poll = (): void => { attach(); if (api() === undefined) refresh() }

  const start = (): void => {
    win.addEventListener(EDITS_EVENT, poll)
    attach()
    timer = setInterval(poll, POLL_MS)
    ;(timer as { unref?: () => void }).unref?.()
    refresh()
  }
  const stop = (): void => {
    win.removeEventListener(EDITS_EVENT, poll)
    unsubscribeApi?.()
    unsubscribeApi = undefined
    apiFor = undefined
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  return {
    setRoot(next) {
      if (next === root) return
      root = next
      refresh()
    },
    get: () => marks,
    subscribe(callback) {
      listeners.add(callback)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(callback)
        if (listeners.size === 0) stop()
      }
    },
  }
}
