// dsh-web-terminal — SSH targets on the client: validation (the host's own module, so the dialog and the host
// agree), the label shown on windows, and the socket parameters. A target is never anything secret: ssh asks for
// passwords and passphrases in the terminal.

import { parseQuickConnect, validateSsh } from '../../lib/ssh-target.js'
import type { SshTarget } from './types.ts'

/** Validate raw input; the result holds only the four known fields, so nothing else can ride along into storage. */
export function checkSsh(raw: unknown): { ok: true; ssh: SshTarget } | { ok: false; error: string } {
  const v = validateSsh(raw) as { ok: boolean; ssh?: SshTarget; error?: string }
  return v.ok && v.ssh !== undefined ? { ok: true, ssh: v.ssh } : { ok: false, error: v.error ?? 'Invalid SSH target' }
}

/** A stored or restored target, or undefined when it is missing or no longer valid. */
export function cleanSsh(raw: unknown): SshTarget | undefined {
  const v = checkSsh(raw)
  return v.ok ? v.ssh : undefined
}

export function cleanSshList(raw: unknown[]): SshTarget[] {
  const seen = new Set<string>()
  const out: SshTarget[] = []
  for (const item of raw) {
    const ssh = cleanSsh(item)
    if (ssh === undefined || seen.has(sshKey(ssh))) continue
    seen.add(sshKey(ssh))
    out.push(ssh)
  }
  return out
}

/** Same machine, port and command. */
export function sshKey(ssh: SshTarget): string {
  return JSON.stringify([ssh.host ?? null, ssh.target ?? null, ssh.port ?? null, ssh.command ?? null])
}

/** What a window or row shows: the alias, or `user@host`, with `:port` when a port was given. */
export function sshLabel(ssh: SshTarget): string {
  if (ssh.host !== undefined) return ssh.host
  return `${ssh.target ?? ''}${ssh.port !== undefined ? `:${ssh.port}` : ''}`
}

/** Window default name: `ssh: <alias or host>` (the user part and port are in the badge). */
export function sshTitle(ssh: SshTarget): string {
  return `ssh: ${ssh.host ?? (ssh.target ?? '').replace(/^[^@]*@/, '')}`
}

/** The query parameters that make the host run ssh for this target. */
export function sshParams(ssh: SshTarget): Record<string, string> {
  const out: Record<string, string> = {}
  if (ssh.host !== undefined) out.sshHost = ssh.host
  if (ssh.target !== undefined) out.sshTarget = ssh.target
  if (ssh.port !== undefined) out.sshPort = String(ssh.port)
  if (ssh.command !== undefined) out.sshCommand = ssh.command
  return out
}

/** The quick-connect text for a stored target (user@host:port). */
export function quickText(ssh: SshTarget): string {
  return ssh.target === undefined ? '' : `${ssh.target}${ssh.port !== undefined ? `:${ssh.port}` : ''}`
}

/**
 * Turn the dialog's fields into a target: the typed `user@host[:port]` wins over a picked alias.
 * @returns the target, or the message to show under the field.
 */
export function resolveSsh(input: { alias: string | null; quick: string; command: string }): { ok: true; ssh: SshTarget } | { ok: false; error: string } {
  const quick = input.quick.trim()
  if (quick.length > 0) {
    const parsed = parseQuickConnect(quick) as { target?: string; port?: number; error?: string }
    if (parsed.target === undefined) return { ok: false, error: parsed.error ?? 'Invalid address' }
    return checkSsh({ target: parsed.target, port: parsed.port, command: input.command })
  }
  if (input.alias === null) return { ok: false, error: 'Pick a host or type user@host' }
  return checkSsh({ host: input.alias, command: input.command })
}
