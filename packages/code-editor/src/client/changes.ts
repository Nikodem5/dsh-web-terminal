// dsh-code-editor - the CHANGES list: grouping a git status payload and the discard plan.

import type { GitFile, GitStatus } from './types.ts'

export interface ChangeGroups {
  staged: GitFile[]
  changes: GitFile[]
  untracked: GitFile[]
}

export type GroupName = keyof ChangeGroups

/** Staged / Changes (modified, deleted, conflicted in the work tree) / Untracked. A file staged AND modified shows in both. */
export function groupChanges(status: Pick<GitStatus, 'files'> | null | undefined): ChangeGroups {
  const g: ChangeGroups = { staged: [], changes: [], untracked: [] }
  for (const f of status?.files ?? []) {
    if (f.untracked) g.untracked.push(f)
    else {
      if (f.staged && !f.conflicted) g.staged.push(f)
      if (f.unstaged || f.conflicted) g.changes.push(f)
    }
  }
  const byPath = (a: GitFile, b: GitFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  g.staged.sort(byPath)
  g.changes.sort(byPath)
  g.untracked.sort(byPath)
  return g
}

/** One-letter status badge for a file in a given group (M, A, D, R, U, !). */
export function statusLetter(f: GitFile, group: GroupName): string {
  if (group === 'untracked') return 'U'
  if (f.conflicted) return '!'
  const c = group === 'staged' ? f.index : f.worktree
  return c === '.' || c === ' ' || c === '' ? 'M' : c === '?' ? 'U' : c
}

export interface DiscardPlan {
  /** Tracked paths restored from the index. */
  paths: string[]
  /** Untracked files that will be DELETED. */
  untracked: string[]
  /** The text of the confirmation dialog. */
  message: string
}

/** What Discard on these files would do; untracked ones are deleted, so the message lists each of them. */
export function planDiscard(files: readonly GitFile[]): DiscardPlan {
  const untracked = files.filter((f) => f.untracked).map((f) => f.path)
  const paths = files.filter((f) => !f.untracked).map((f) => f.path)
  const lines: string[] = []
  if (paths.length > 0) lines.push(`Discard changes in ${paths.length === 1 ? paths[0] : `${paths.length} files`}? This cannot be undone.`)
  if (untracked.length > 0) {
    lines.push(`${untracked.length === 1 ? 'This untracked file' : `These ${untracked.length} untracked files`} will be DELETED from disk:`)
    for (const p of untracked.slice(0, 15)) lines.push(`  ${p}`)
    if (untracked.length > 15) lines.push(`  ...and ${untracked.length - 15} more`)
  }
  return { paths, untracked, message: lines.join('\n') }
}
