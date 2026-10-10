// dsh-code-editor - shared types (mirror of packages/code-editor/API.md).

export interface RootInfo { path: string; exists: boolean; isGit: boolean }
export interface TreeEntry { name: string; type: 'file' | 'dir' | 'symlink'; size: number; mtime: number }
export interface FileData { content: string | null; mtime: number; size: number; binary: boolean; tooLarge: boolean; eol: 'lf' | 'crlf' }
export interface GitFile {
  path: string
  origPath?: string
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}
export interface GitStatus { branch: string | null; ahead: number; behind: number; files: GitFile[] }
export interface GitDiff { original: string | null; modified: string | null; binary: boolean; tooLarge: boolean }

export type WsFrame =
  | { type: 'hello'; root: string }
  | { type: 'changed'; paths: string[]; overflow?: boolean }
  | { type: 'git' }

/** What another plugin may ask for (`window` event `dsh-code-editor:open`). */
export interface OpenRequest { path: string; line?: number; col?: number; review?: boolean; root?: string }
