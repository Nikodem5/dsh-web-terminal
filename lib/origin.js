// Origin policy for the terminal WebSocket.
//
// A shell is remote code execution, and a browser lets ANY web page open a
// WebSocket to 127.0.0.1. The Origin header is the one thing a page cannot
// forge, so the upgrade is refused when it names a site we do not recognise.
//
// The policy is deliberately a permissive allowlist rather than one strict
// value: the desktop app serves its UI from `dsh-app://app` and rewrites
// Origin/cookie for the loopback address, and the exact Origin it ends up
// sending is not known, so every plausible legitimate form is accepted.

/** Hostnames that mean "this machine" (URL.hostname keeps the brackets on IPv6). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Parse the comma separated extra-origins setting into normalised origins.
 * @param raw - value of DSH_WT_ALLOWED_ORIGINS, if any.
 * @returns lowercase origins without a trailing slash.
 */
export function parseExtraOrigins(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, '').toLowerCase())
    .filter((entry) => entry.length > 0)
}

/**
 * Decide whether a WebSocket upgrade may proceed.
 * @param origin - the `Origin` header value, undefined when absent.
 * @param host - the request `Host` header.
 * @param extra - extra allowed origins from {@link parseExtraOrigins}.
 * @returns true when the upgrade is allowed.
 */
export function originAllowed(origin, host, extra = []) {
  // Non-browser clients (and the test suite) send no Origin at all.
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin.length === 0) return false
  let url
  try {
    url = new URL(origin)
  } catch {
    // Includes the opaque "null" origin of sandboxed frames and file:// pages.
    return false
  }
  if (url.protocol === 'dsh-app:') return true
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (LOOPBACK_HOSTS.has(url.hostname)) return true
  if (typeof host === 'string' && host.length > 0 && url.host.toLowerCase() === host.toLowerCase()) return true
  return extra.includes(origin.replace(/\/+$/, '').toLowerCase())
}
