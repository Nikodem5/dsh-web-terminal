// The per-boot access token the host puts into the page (shared/host/local-auth.js).
// Every request to a plugin route carries it as a Bearer header; a WebSocket carries it as a
// subprotocol, because browsers cannot set headers on one.

/** Page global the host's index-inject row sets. Keep in step with TOKEN_GLOBAL in shared/host/local-auth.js. */
const TOKEN_GLOBAL = '__DSH_WT_TOKEN__'
const WS_PROTOCOL = 'dsh-wt'

/** The token, or '' when the page was served without it (the host then answers 401). */
export function accessToken(): string {
  const value = (globalThis as Record<string, unknown>)[TOKEN_GLOBAL]
  return typeof value === 'string' ? value : ''
}

/** `headers` plus the Authorization header. */
export function withAuth(headers: Record<string, string> = {}): Record<string, string> {
  const token = accessToken()
  return token === '' ? headers : { ...headers, authorization: `Bearer ${token}` }
}

/** WebSocket subprotocols to offer: the plain one the host answers with, then the one carrying the token. */
export function socketProtocols(): string[] {
  const token = accessToken()
  return token === '' ? [WS_PROTOCOL] : [WS_PROTOCOL, `${WS_PROTOCOL}.${token}`]
}
