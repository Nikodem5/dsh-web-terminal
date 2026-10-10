// Shell choices, their arguments, and the shell-integration injection (OSC 133/633 command blocks).
//
// Integration is injected at spawn time and never touches the user's files: PowerShell dot-sources
// `shell/integration.ps1` after its profile, bash is started with `--rcfile shell/integration.bash`.

import { fileURLToPath } from 'node:url'

/** Where integration.ps1 / integration.bash live (shipped inside lib/, so install.mjs copies them). */
export const SHELL_DIR = fileURLToPath(new URL('./shell/', import.meta.url))

/** Shell choices the picker can offer, keyed by the id the browser sends. */
export const WINDOWS_SHELLS = {
  powershell: { label: 'PowerShell', file: 'powershell.exe', args: ['-NoLogo'] },
  pwsh: { label: 'PowerShell 7', file: 'pwsh.exe', args: ['-NoLogo'] },
  cmd: { label: 'Command Prompt', file: 'cmd.exe', args: [] },
  // `file` is the stock location; the real one is looked up by gitBash.resolve (Git is often installed elsewhere).
  gitbash: { label: 'Git Bash', file: 'C:/Program Files/Git/bin/bash.exe', args: ['-i', '-l'] },
  wsl: { label: 'WSL', file: 'wsl.exe', args: [] },
}
export const POSIX_SHELLS = {
  bash: { label: 'bash', file: '/bin/bash', args: ['-i'] },
  zsh: { label: 'zsh', file: '/bin/zsh', args: ['-i'] },
  sh: { label: 'sh', file: '/bin/sh', args: ['-i'] },
}

/** The platform default shell, and its arguments. */
export function defaultShellSpec(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const shell = env.COMSPEC ?? 'powershell.exe'
    return { file: shell, args: shell.toLowerCase().endsWith('powershell.exe') || shell.toLowerCase().endsWith('pwsh.exe') ? ['-NoLogo'] : [] }
  }
  return { file: env.SHELL ?? '/bin/bash', args: ['-i'] }
}

/** Single-quote a string for PowerShell (a quote is doubled). */
export function psQuote(text) {
  return `'${String(text).replaceAll("'", "''")}'`
}

/**
 * Which integration script suits a shell program. Only what was tested gets one: cmd, sh, zsh, fish and wsl
 * stay plain (zsh needs a ZDOTDIR shim that is not written yet).
 * @param file - program path or name.
 * @returns `'ps'`, `'bash'`, or undefined.
 */
export function integrationKind(file) {
  const base = String(file).replaceAll('\\', '/').split('/').pop().toLowerCase().replace(/\.exe$/, '')
  if (base === 'powershell' || base === 'pwsh') return 'ps'
  if (base === 'bash') return 'bash'
  return undefined
}

/** Whether integration is allowed at all: `DSH_WT_SHELL_INTEGRATION=0` (or false/off) turns it off for every shell. */
export function integrationEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.DSH_WT_SHELL_INTEGRATION ?? '').trim())
}

/**
 * Resolve a browser-supplied shell id to a program and its arguments. Unknown ids fall back to the default so a
 * stale saved layout can never fail to open.
 * @param id - shell key from the query string.
 * @param options.integration - false when the client or the host turned integration off for this launch.
 * @param options.shellDir - folder holding the integration scripts (tests override it).
 * @returns `{file, args, env?, integrated}`; `env` holds extra variables the integration script reads.
 */
export function shellSpec(id, { platform = process.platform, env = process.env, integration = true, shellDir = SHELL_DIR } = {}) {
  const table = platform === 'win32' ? WINDOWS_SHELLS : POSIX_SHELLS
  const entry = typeof id === 'string' ? table[id] : undefined
  const spec = entry === undefined ? defaultShellSpec(platform, env) : { file: entry.file, args: entry.args }
  const kind = integration && integrationEnabled(env) ? integrationKind(spec.file) : undefined
  if (kind === undefined) return { file: spec.file, args: spec.args, integrated: false }
  // Forward slashes work everywhere (bash.exe, PowerShell) and need no escaping, spaces aside.
  const dir = shellDir.replaceAll('\\', '/')
  if (kind === 'ps') {
    // Dot-sourced from text, not by path: a Restricted execution policy blocks script files but not this.
    // -Command runs after the profile; -NoExit keeps the session interactive.
    const script = `${dir}integration.ps1`
    return { file: spec.file, args: [...spec.args, '-NoExit', '-Command', `. ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(script)})))`], integrated: true }
  }
  // `-l` would make bash ignore --rcfile, so a login shell (Git Bash) is started plain and the script replays the login files.
  const login = spec.args.includes('-l')
  return {
    file: spec.file,
    args: ['--rcfile', `${dir}integration.bash`, '-i'],
    env: login ? { DSH_WT_BASH_LOGIN: '1' } : undefined,
    integrated: true,
  }
}
