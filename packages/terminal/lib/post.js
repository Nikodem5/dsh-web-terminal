// dsh-web-terminal — shared helpers of the scripts Claude Code runs (status line, hook forwarder).
// Cheap and silent on purpose: nothing here throws or prints.

import { request } from 'node:http'

const TOKEN_HEADER = 'x-dsh-wt-token'

/**
 * Fire-and-forget POST to the host; resolves when done, never rejects.
 * The token only ever goes to this machine's own host process (http, 127.0.0.1).
 */
export function postJson(url, token, body, timeoutMs = 500) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return resolve()
    }
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') return resolve()
    const req = request(
      target,
      { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json', 'content-length': body.length, [TOKEN_HEADER]: token } },
      (res) => {
        res.resume()
        res.on('end', resolve)
        res.on('error', resolve)
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve())
    req.on('close', () => resolve())
    req.end(body)
  })
}

/** All of stdin as a Buffer (empty on any failure). */
export async function readStdin() {
  const chunks = []
  try {
    for await (const chunk of process.stdin) chunks.push(chunk)
  } catch {}
  return Buffer.concat(chunks)
}
