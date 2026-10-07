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

/** Port a URL really uses: explicit, else the scheme default. */
function effectivePort(url) {
  return url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
}

/**
 * Decide whether a WebSocket upgrade may proceed.
 *
 * A web page is allowed only when it is the harness's own page (same loopback host and port as
 * the request's `Host`), which is what the desktop app and a locally served UI send. Two things
 * are deliberately NOT enough on their own:
 *  - a loopback Origin on some other port: any local web app (a dev server, a docs site) would
 *    then be able to open a shell;
 *  - an Origin equal to the `Host` header when that host is not loopback: a DNS-rebinding page
 *    sends the same attacker-chosen name in both. A harness reached by a non-loopback name must
 *    be allowed explicitly through `DSH_WT_ALLOWED_ORIGINS`.
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
  // The desktop app's own scheme: a web page cannot send it.
  if (url.protocol === 'dsh-app:') return true
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (extra.includes(origin.replace(/\/+$/, '').toLowerCase())) return true
  if (typeof host !== 'string' || host.length === 0) return false
  let target
  try {
    target = new URL(`http://${host}`)
  } catch {
    return false
  }
  // Same loopback machine and same port as this server. localhost, 127.0.0.1 and [::1] are
  // interchangeable: an app may say one while the socket says another.
  return LOOPBACK_HOSTS.has(target.hostname) && LOOPBACK_HOSTS.has(url.hostname) && effectivePort(url) === effectivePort(target)
}
