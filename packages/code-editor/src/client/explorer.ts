// dsh-code-editor - the harness Workspaces as root choices, and the explorer tree as a flat list of rows.

import type { TreeEntry } from './types.ts'
import { baseName, joinRel } from './paths.ts'

export interface WorkspaceChoice { label: string; path: string }

/** `useWorkspaces(s => s.items)` to choices: skips entries without a usable path and repeats of one folder. */
export function workspaceChoices(items: unknown): WorkspaceChoice[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const out: WorkspaceChoice[] = []
  for (const item of items as Array<{ path?: unknown; title?: unknown }>) {
    if (typeof item !== 'object' || item === null || typeof item.path !== 'string') continue
    const path = item.path.trim()
    if (path.length === 0 || seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    out.push({ label: typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : baseName(path), path })
  }
  return out
}

export interface TreeRow {
  kind: 'dir' | 'file' | 'note'
  /** Path relative to the root ('' for notes). */
  path: string
  name: string
  depth: number
  expanded: boolean
  loading: boolean
  symlink: boolean
  /** Text for `note` rows (loading / error / empty). */
  text?: string
}

interface Node { entries: TreeEntry[] | null; loading: boolean; error: string | null }

/** Flatten the loaded tree into rows, descending into expanded directories only. */
export function flattenTree(tree: Record<string, Node>, expanded: readonly string[], dir = '', depth = 0): TreeRow[] {
  const node = tree[dir]
  const out: TreeRow[] = []
  if (!node || (node.entries === null && node.loading)) {
    out.push({ kind: 'note', path: '', name: '', depth, expanded: false, loading: true, symlink: false, text: 'Loading...' })
    return out
  }
  if (node.error && node.entries === null) {
    out.push({ kind: 'note', path: '', name: '', depth, expanded: false, loading: false, symlink: false, text: node.error })
    return out
  }
  const open = new Set(expanded)
  for (const e of node.entries ?? []) {
    const path = joinRel(dir, e.name)
    if (e.type === 'dir') {
      const isOpen = open.has(path)
      out.push({ kind: 'dir', path, name: e.name, depth, expanded: isOpen, loading: tree[path]?.loading === true, symlink: false })
      if (isOpen) out.push(...flattenTree(tree, expanded, path, depth + 1))
    } else {
      out.push({ kind: 'file', path, name: e.name, depth, expanded: false, loading: false, symlink: e.type === 'symlink' })
    }
  }
  if (out.length === 0 && dir !== '') out.push({ kind: 'note', path: '', name: '', depth, expanded: false, loading: false, symlink: false, text: '(empty)' })
  return out
}
