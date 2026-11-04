// dsh-web-terminal — dropping files from the OS onto a terminal (pure quoting here; the DOM wiring is below).
//
// The pasted text is the quoted path and nothing else: no newline, no trailing space beyond the separator
// between items, so nothing runs until the user presses Enter themselves. A path that cannot be quoted
// safely for the terminal's shell is skipped rather than pasted raw.

export type DropShell = 'powershell' | 'cmd' | 'posix' | 'gitbash' | 'wsl' | 'ambiguous'

/**
 * How a terminal's shell quotes a path. `shellId` is WinState.shell (a host shell id or 'default'); `windows` is
 * whether the host runs Windows. 'default' on Windows is the host's COMSPEC (cmd.exe unless changed), which the
 * client cannot see, so it gets 'ambiguous': only a quoting that means the same in cmd and PowerShell.
 */
export function dropShellKind(shellId: string, windows: boolean): DropShell {
  const id = shellId.trim().toLowerCase().replace(/\.exe$/, '')
  if (id === 'powershell' || id === 'pwsh') return 'powershell'
  if (id === 'cmd') return 'cmd'
  if (id === 'gitbash') return 'gitbash'
  if (id === 'wsl') return 'wsl'
  if (id === 'bash' || id === 'zsh' || id === 'sh') return 'posix'
  return windows ? 'ambiguous' : 'posix'
}

/** Control characters (newline, ESC, ...) never go into a paste: they could run the line or end a bracketed paste. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

function posixQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** `C:\a\b` as Git Bash (`/c/a/b`) or WSL (`/mnt/c/a/b`) sees it; other paths just get forward slashes. */
function unixPathOf(p: string, prefix: string): string | undefined {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (m !== null) return `${prefix}${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}`
  if (/^\\\\/.test(p)) return undefined // UNC: no portable spelling
  return p.replaceAll('\\', '/')
}

/** `p` quoted for `shell`, or undefined when it cannot be done without the shell expanding or running something. */
export function quotePath(p: string, shell: DropShell): string | undefined {
  if (p.length === 0 || CONTROL.test(p)) return undefined
  switch (shell) {
    case 'powershell':
      // Single quotes expand nothing; PowerShell also treats the curly single quotes as quotes, so double those too.
      return `'${p.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c)}'`
    case 'cmd':
      // cmd expands %VAR% even inside quotes and has no escape for it; " cannot appear in a Windows file name.
      return /["%]/.test(p) ? undefined : `"${p}"`
    case 'ambiguous':
      // Double quotes read the same in cmd and PowerShell only when neither has anything to expand.
      return /["%$`!^&]/.test(p) ? undefined : `"${p}"`
    case 'gitbash': {
      const u = unixPathOf(p, '/')
      return u === undefined ? undefined : posixQuote(u)
    }
    case 'wsl': {
      const u = unixPathOf(p, '/mnt/')
      return u === undefined ? undefined : posixQuote(u)
    }
    case 'posix':
      return posixQuote(p)
  }
}

export interface DropPlan {
  /** Text to paste (items joined by a space, plus a trailing space so the user can keep typing); empty = nothing. */
  text: string
  /** Paths that could not be pasted (no full path, or unquotable for this shell). */
  skipped: number
}

/** The paste for dropped `paths` (undefined/empty entries are files with no known full path). */
export function planDrop(paths: readonly (string | undefined)[], shell: DropShell): DropPlan {
  const quoted: string[] = []
  let skipped = 0
  for (const p of paths) {
    const q = p === undefined ? undefined : quotePath(p, shell)
    if (q === undefined) skipped += 1
    else quoted.push(q)
  }
  return { text: quoted.length === 0 ? '' : `${quoted.join(' ')} `, skipped }
}
