// dsh-web-terminal — window names: folder labels and the program-derived title.

import { runtimes } from './state.ts'
import type { WinState } from './types.ts'

/** Last path segment, for compact folder labels. */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Shells and terminals whose own title is just their name (optionally with a version or ": detail"). */
const SHELL_NAME =
  /^(?:Windows PowerShell|PowerShell|pwsh|Command Prompt|cmd|bash|zsh|sh|fish|dash|wsl|Ubuntu|Debian)(?:\s+[\d.]+)?(?:\s*:.*)?$/i

/**
 * Turn a program-set terminal title into a window name, or undefined when it is
 * only the shell's own path/banner. Claude Code puts a status glyph in front of
 * its session title ("✳ Fix login bug"); that prefix is dropped.
 */
export function cleanTitle(raw: string, cwd: string): string | undefined {
  // Drop the status glyph / spinner, but keep "/", "~" and a backslash: they are what makes
  // a title a path, and stripping them first would let "/usr/bin/bash" through as a name.
  const t = raw.replace(/^[^\p{L}\p{N}/~\\]+/u, '').trim()
  if (t.length === 0) return undefined
  if (/^[A-Za-z]:[\\/]/.test(t) || /^[/~\\]/.test(t)) return undefined
  if (/\.exe\b/i.test(t)) return undefined
  // bash/zsh default: "user@host: ~/projects" or "user@host:/var/log".
  if (/^[\w.-]+@[\w.-]+(?:\s*:.*)?$/.test(t)) return undefined
  // Git Bash / MSYS2 ("MINGW64:/c/Users/me") and elevated Windows shells ("Administrator: cmd").
  if (/^(?:MSYS|MINGW\d*)\b/i.test(t) || /^Administrator\b/i.test(t)) return undefined
  if (SHELL_NAME.test(t)) return undefined
  // Some shells title the window with just the current directory's name.
  if (cwd.length > 0 && t.toLowerCase() === baseName(cwd).toLowerCase()) return undefined
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
