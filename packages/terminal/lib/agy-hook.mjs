// dsh-web-terminal — Antigravity CLI hook (runs inside agy, not the host).
//
// Copied as `hook.mjs` into the plugin the user installs from the Terminals page (lib/agy-integration.js).
// agy runs it for SessionStart, PreInvocation, PostToolUse and Stop with the event's JSON on stdin, in the
// plugin's folder. It forwards `{ event, payload }` to the host that started the terminal:
//   POST <DSH_WT_AGY_SIGNAL>/antigravity-hook   with header x-dsh-wt-token: <DSH_WT_TOKEN>
// Both variables exist only in terminals the plugin opened, so an agy started anywhere else (the plugin
// is global) does nothing. It always prints `{}` (no decision, no injected steps) and exits 0, and it is
// self-contained (no imports from the package) because it runs from the copy.

import { request } from 'node:http'

const TIMEOUT_MS = 1500
/** The parts of a payload the host reads; the rest (the user's last prompt...) never leaves agy. */
const KEEP = ['conversationId', 'toolCall', 'error', 'terminationReason', 'fullyIdle', 'workspacePaths']

async function readStdin() {
  const chunks = []
  try {
    for await (const chunk of process.stdin) chunks.push(chunk)
  } catch {}
  return Buffer.concat(chunks).toString('utf8')
}

function post(url, token, body) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return resolve()
    }
    // The secret only ever goes to this machine's own host process.
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') return resolve()
    const data = Buffer.from(body)
    const req = request(target, { method: 'POST', timeout: TIMEOUT_MS, headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-dsh-wt-token': token } }, (res) => {
      res.resume()
      res.on('end', resolve)
      res.on('error', resolve)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve())
    req.on('close', () => resolve())
    req.end(data)
  })
}

async function main() {
  const event = process.argv[2]
  const base = process.env.DSH_WT_AGY_SIGNAL
  const token = process.env.DSH_WT_TOKEN
  const input = await readStdin()
  if (!event || !base || !token) return
  let payload = {}
  try {
    const parsed = JSON.parse(input)
    if (parsed !== null && typeof parsed === 'object') for (const key of KEEP) if (key in parsed) payload[key] = parsed[key]
  } catch {
    payload = {}
  }
  await post(`${base}/antigravity-hook`, token, JSON.stringify({ event, payload }))
}

main()
  .catch(() => {})
  .finally(() => {
    process.stdout.write('{}')
    process.exitCode = 0
  })
