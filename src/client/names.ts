// dsh-web-terminal — window names: folder labels and the program-derived title.

import { runtimes } from './state.ts'
import type { WinState } from './types.ts'

/** Last path segment, for compact folder labels. */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/**
 * Turn a program-set terminal title into a window name, or undefined when it is
 * only the shell's own path/banner. Claude Code puts a status glyph in front of
 * its session title ("✳ Fix login bug"); that prefix is dropped.
 */
export function cleanTitle(raw: string, cwd: string): string | undefined {
  const t = raw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  if (t.length === 0) return undefined
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('~')) return undefined
  if (/\.exe\b/i.test(t) || /^(Windows PowerShell|PowerShell|Command Prompt|Administrator|MINGW|bash|zsh|sh|cmd)\b/i.test(t)) return undefined
  if (/^Claude Code$/i.test(t)) return cwd.length > 0 ? `Claude · ${baseName(cwd)}` : 'Claude'
  return t.length > 60 ? `${t.slice(0, 59)}…` : t
}

/** The name shown everywhere: the user's, else the program's, else the default. */
export function displayName(win: WinState): string {
  if (win.nameManual === true) return win.title
  const rt = runtimes.get(win.id)
  const live = rt === undefined ? undefined : cleanTitle(rt.title, win.cwd)
  return live ?? win.autoName ?? win.title
}
