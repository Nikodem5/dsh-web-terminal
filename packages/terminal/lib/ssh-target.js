// SSH targets: strict validation and the ssh argv. Pure (no node imports) because the browser bundle shares it
// with the host: the dialog shows the same errors the host would refuse with.
//
// The host never builds a shell string. Everything reaches `ssh` as argv, after a `--`, so a value can at worst
// be a wrong destination, never an option (`-oProxyCommand=...`). The destination is checked against a
// conservative pattern on top of that.

/** A name from ~/.ssh/config (or any plain hostname): letters, digits, `.`, `_`, `-`; never a leading `-`. */
const ALIAS = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/
/** DNS name or IPv4: starts and ends with a letter or digit. */
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/
const IPV6_BODY = /^[0-9A-Fa-f:.]{2,45}$/

/** Longest remote command accepted (it is one argv element on the local command line). */
export const MAX_COMMAND = 2048

/** @returns whether `value` is a usable ssh_config alias. */
export function isAlias(value) {
  return typeof value === 'string' && ALIAS.test(value)
}

/**
 * Split and check `[user@]host` where host is a name, an IPv4 address or a bracketed IPv6 address.
 * @returns `{user?, host, bare}` (`bare` has no brackets, which is how ssh wants it) or `{error}`.
 */
function parseDestination(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'Enter user@host' }
  const at = text.indexOf('@')
  const user = at >= 0 ? text.slice(0, at) : undefined
  const host = at >= 0 ? text.slice(at + 1) : text
  if (user !== undefined && !USER.test(user)) return { error: 'The user may only contain letters, digits, . _ - and must not start with -' }
  if (host.startsWith('[')) {
    const inner = host.endsWith(']') ? host.slice(1, -1) : ''
    if (!IPV6_BODY.test(inner) || inner.split(':').length < 3) return { error: 'Not a valid [IPv6] address' }
    return { user, host, bare: inner }
  }
  if (!HOSTNAME.test(host)) return { error: 'The host may only contain letters, digits, . _ - and must not start with -' }
  return { user, host, bare: host }
}

/** @returns an integer 1-65535, `undefined` for "none", or `null` when invalid. */
function parsePort(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : /^\d{1,5}$/.test(String(value)) ? Number(value) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/**
 * Split what a person types into the quick-connect box: `user@host`, `host:2222`, `user@[::1]:2222`.
 * @returns `{target, port?}` ready for validateSsh, or `{error}`.
 */
export function parseQuickConnect(text) {
  const t = String(text).trim()
  if (t.length === 0) return { error: 'Enter user@host' }
  const at = t.indexOf('@')
  const head = at >= 0 ? `${t.slice(0, at)}@` : ''
  const rest = at >= 0 ? t.slice(at + 1) : t
  let host = rest
  let port
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']')
    if (end < 0) return { error: 'Not a valid [IPv6] address' }
    host = rest.slice(0, end + 1)
    const after = rest.slice(end + 1)
    if (after.length > 0) {
      if (!after.startsWith(':')) return { error: 'Expected :port after the ]' }
      port = after.slice(1)
    }
  } else {
    const colon = rest.indexOf(':')
    if (colon >= 0) {
      if (rest.indexOf(':', colon + 1) >= 0) return { error: 'Put an IPv6 address in [brackets]' }
      host = rest.slice(0, colon)
      port = rest.slice(colon + 1)
    }
  }
  const p = parsePort(port)
  if (p === null || port === '') return { error: 'The port must be a number from 1 to 65535' }
  return p === undefined ? { target: `${head}${host}` } : { target: `${head}${host}`, port: p }
}

/**
 * Validate one ssh request.
 * @param input - `{host}` (a ~/.ssh/config alias) or `{target}` (`[user@]host`), plus optional `port` and `command`.
 * @returns `{ok: true, ssh, destination}` where `ssh` is the normalised request (safe to store: no secrets exist in
 *   it) and `destination` is the one argv element ssh gets, or `{ok: false, error}`.
 */
export function validateSsh(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const hasHost = raw.host !== undefined && raw.host !== null && raw.host !== ''
  const hasTarget = raw.target !== undefined && raw.target !== null && raw.target !== ''
  if (hasHost === hasTarget) return { ok: false, error: 'Give either a host alias or user@host' }
  const ssh = {}
  let destination
  if (hasHost) {
    if (!isAlias(raw.host)) return { ok: false, error: 'The host alias may only contain letters, digits, . _ - and must not start with -' }
    ssh.host = raw.host
    destination = raw.host
  } else {
    const parsed = parseDestination(raw.target)
    if (parsed.error !== undefined) return { ok: false, error: parsed.error }
    ssh.target = raw.target
    destination = parsed.user === undefined ? parsed.bare : `${parsed.user}@${parsed.bare}`
  }
  const port = parsePort(raw.port)
  if (port === null) return { ok: false, error: 'The port must be a number from 1 to 65535' }
  if (port !== undefined) ssh.port = port
  if (raw.command !== undefined && raw.command !== null) {
    if (typeof raw.command !== 'string') return { ok: false, error: 'The remote command must be text' }
    const command = raw.command.trim()
    // One line: a newline or other control character has no business in an argv element or a status line.
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(command)) return { ok: false, error: 'The remote command must be a single line' }
    if (command.length > MAX_COMMAND) return { ok: false, error: `The remote command is longer than ${MAX_COMMAND} characters` }
    if (command.length > 0) ssh.command = command
  }
  return { ok: true, ssh, destination }
}

/**
 * The arguments for the `ssh` program (without the program itself).
 * `-t` forces a PTY even with a remote command; the keepalives make a dead link end in about 90 s instead of hanging.
 * @param value - a validateSsh result with `ok: true`.
 */
export function sshArgs(value) {
  const args = ['-t', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3']
  if (value.ssh.port !== undefined) args.push('-p', String(value.ssh.port))
  args.push('--', value.destination)
  if (value.ssh.command !== undefined) args.push(value.ssh.command)
  return args
}
