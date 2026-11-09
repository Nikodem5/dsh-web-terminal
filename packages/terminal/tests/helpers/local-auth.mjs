// What a legitimate local client sends to the plugin's routes (see lib/shared/local-auth.js).
import { bootToken } from '../../lib/shared/local-auth.js'

/** Headers of an authorised request. */
export const authHeaders = (extra = {}) => ({ authorization: `Bearer ${bootToken()}`, ...extra })

/** Options for `new WebSocket(url, options)` from the `ws` package, carrying the token. */
export const authed = (options = {}) => ({ ...options, headers: authHeaders(options.headers) })

/** A fake request to an HTTP handler: a loopback peer, a loopback Host and the token. */
export const localReq = (extra = {}) => ({
  method: 'GET',
  socket: { remoteAddress: '127.0.0.1' },
  ...extra,
  headers: authHeaders({ host: '127.0.0.1:3081', ...extra.headers }),
})
