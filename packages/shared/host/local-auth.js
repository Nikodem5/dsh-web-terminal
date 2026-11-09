// Who may talk to a plugin's HTTP routes and WebSockets.
//
// A route that spawns a program or reads files is remote code execution for whoever can call it, and
// the harness web server has no authentication of its own: `dsh web --host 0.0.0.0`, a tunnel or a
// reverse proxy would hand it to the network. The Origin header (origin.js) is no answer: it is
// absent for every non-browser client. So a request must pass all of:
//
//  1. the TCP peer is loopback (`req.socket.remoteAddress`);
//  2. the `Host` header names a loopback host. A tunnel or reverse proxy connects from loopback, so
//     (1) alone lets it through; its public Host name is what gives it away. This also stops DNS
//     rebinding, where a hostile page reaches 127.0.0.1 under its own name and could otherwise read
//     the token out of the page;
//  3. the Origin, when there is one, is a recognised page (origin.js);
//  4. a per-boot bearer token. The host puts it into the page through the harness's index-inject
//     table (`exposeToken`), so only code that could load the page can send it. Another web page
//     cannot read the page's script (the same-origin policy), and a local process that merely
//     connects to the port does not have it.
//
// Browsers cannot set headers on a WebSocket, so the token travels as a subprotocol there
// (`dsh-wt.<token>` next to the plain `dsh-wt` the server answers with). Both plugins copy this
// file into their own lib/shared/, so the token is kept on `globalThis`: one token per host process.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { originAllowed } from './origin.js'

/** Name of the page global the client reads the token from. */
export const TOKEN_GLOBAL = '__DSH_WT_TOKEN__'
/** WebSocket subprotocol the server answers with, and the prefix of the one that carries the token. */
export const WS_PROTOCOL = 'dsh-wt'
export const WS_TOKEN_PREFIX = `${WS_PROTOCOL}.`

const SLOT = Symbol.for('dsh-web-terminal.localAuth.token')

/** The token of this host process; made on first use, so every plugin in the process shares it. */
export function bootToken() {
  globalThis[SLOT] ??= randomBytes(32).toString('base64url')
  return globalThis[SLOT]
}

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/** True when a `Host` header (with or without a port) names this machine. */
export function isLoopbackHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/** Constant-time equality of two strings of any length. */
function sameSecret(a, b) {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

/** The token a request presents: `Authorization: Bearer`, else a `dsh-wt.<token>` WebSocket subprotocol. */
function presentedToken(headers) {
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(\S+)$/i.exec(auth.trim())
    if (match !== null) return match[1]
  }
  const protocols = headers['sec-websocket-protocol']
  if (typeof protocols === 'string') {
    for (const entry of protocols.split(',')) {
      const protocol = entry.trim()
      if (protocol.startsWith(WS_TOKEN_PREFIX)) return protocol.slice(WS_TOKEN_PREFIX.length)
    }
  }
  return undefined
}

/**
 * Decide whether a request or upgrade may proceed.
 * @param req - the node request. Anything missing (no socket, no headers) is refused.
 * @param extraOrigins - extra allowed web origins from `parseExtraOrigins`; they never lift the loopback rules.
 * @returns `{ ok: true }`, or the refusal with the status, a short `code` (`origin` keeps its old meaning) and a safe message.
 */
export function checkAccess(req, extraOrigins = []) {
  const headers = req?.headers ?? {}
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return { ok: false, status: 403, code: 'remote', error: 'Only local connections are allowed' }
  if (!isLoopbackHostHeader(headers.host)) return { ok: false, status: 403, code: 'host', error: 'Host not allowed' }
  if (!originAllowed(headers.origin, headers.host, extraOrigins)) return { ok: false, status: 403, code: 'origin', error: 'Origin not allowed' }
  const token = presentedToken(headers)
  if (token === undefined || !sameSecret(token, bootToken())) return { ok: false, status: 401, code: 'auth', error: 'Missing or wrong access token' }
  return { ok: true }
}

/** `handleProtocols` for a `ws` server: answer the plain protocol, never echo the token one. */
export function selectProtocol(protocols) {
  return protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false
}

/**
 * Put the token into every served page as `globalThis[TOKEN_GLOBAL]`, ahead of the page's scripts.
 * Both plugins call this; the duplicate row is the same value.
 * @param ctx - host plugin context (a real cordis ctx; `on` is part of every one).
 * @returns the disposer.
 */
export function exposeToken(ctx) {
  const token = bootToken()
  return ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: TOKEN_GLOBAL, value: token })
  })
}

/** Write a refusal as JSON. */
export function refuse(res, failure) {
  const body = JSON.stringify({ ok: false, error: failure.error, code: failure.code })
  res.writeHead(failure.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Close an upgraded socket with the refusal's status. */
export function refuseUpgrade(socket, failure) {
  socket.on('error', () => {})
  const text = failure.status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.end(`HTTP/1.1 ${failure.status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}
