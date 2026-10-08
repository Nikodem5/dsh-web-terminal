// dsh-web-terminal — status-line wrapper (runs inside Claude Code, not the host).
//
// Claude Code runs the `statusLine` command of the `--settings` file this plugin writes, many
// times a second while a prompt runs. This wrapper does two things with the same stdin:
//  1. POSTs it to the host (`argv[2]`, token from DSH_WT_TOKEN) so the stats bar sees the
//     account limits and the session cost;
//  2. runs the user's own status line (from their Claude settings, which our `statusLine`
//     replaced) and relays its output, so the status line they see does not change.
// Cheap and silent on purpose: it never prints errors and always exits 0.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const POST_TIMEOUT_MS = 500
const USER_TIMEOUT_MS = 5000
/** Set on the user's command so a status line that (indirectly) runs this wrapper again cannot loop. */
const GUARD_ENV = 'DSH_WT_STATUSLINE'

/**
 * The user's own `statusLine` setting, if it is a command.
 * @returns {{command: string, refreshInterval?: number} | undefined}
 */
export function userStatusLine(env = process.env) {
  try {
    const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const line = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))?.statusLine
    if (line?.type !== 'command' || typeof line.command !== 'string' || line.command.trim() === '') return undefined
    return { command: line.command, refreshInterval: typeof line.refreshInterval === 'number' ? line.refreshInterval : undefined }
  } catch {
    return undefined
  }
}

/** Fire-and-forget POST to the host; resolves when done, never rejects. */
function post(url, token, body) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch {
      return resolve()
    }
    // The token only ever goes to this machine's own host process.
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') return resolve()
    const req = request(
      target,
      { method: 'POST', timeout: POST_TIMEOUT_MS, headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-dsh-wt-token': token } },
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

/** Run the user's command with `input` on stdin; resolves with its stdout ('' on any failure). */
function runUser(command, input) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, [GUARD_ENV]: '1' } })
    } catch {
      return resolve('')
    }
    const out = []
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve(Buffer.concat(out).toString('utf8'))
    }, USER_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(out).toString('utf8')) })
    child.stdin.end(input)
  })
}

async function readStdin() {
  const chunks = []
  try {
    for await (const chunk of process.stdin) chunks.push(chunk)
  } catch {}
  return Buffer.concat(chunks)
}

async function main() {
  const input = await readStdin()
  const token = process.env.DSH_WT_TOKEN
  const url = process.argv[2]
  const user = process.env[GUARD_ENV] === '1' ? undefined : userStatusLine()
  // Our own entry in the user's settings (or an echo of this file) would run us again: skip it.
  const runnable = user !== undefined && !user.command.includes('statusline.js')
  const [, output] = await Promise.all([
    token && url ? post(url, token, input) : undefined,
    runnable ? runUser(user.command, input) : '',
  ])
  if (output) process.stdout.write(output)
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => { process.exitCode = 0 })
}
