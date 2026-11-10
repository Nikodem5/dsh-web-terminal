// dsh-web-terminal — status-line wrapper (runs inside Claude Code, not the host).
//
// Claude Code runs the `statusLine` command of the `--settings` file this plugin writes, many
// times a second while a prompt runs. This wrapper does two things with the same stdin:
//  1. POSTs it to the host (`argv[2]`, token from DSH_WT_TOKEN) so the stats bar sees the
//     account limits and the session cost;
//  2. runs the user's own status line (from their Claude settings, which our `statusLine`
//     replaced) and relays its output, so the status line they see does not change.
// `statusline.js --subagents <url>` is the same for the `subagentStatusLine` setting: it posts the
// sub-agent task list and relays the user's own `subagentStatusLine`, or prints nothing (Claude
// only overrides the rows a status line prints, so nothing leaves its default rows alone).
// Cheap and silent on purpose: it never prints errors and always exits 0.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postJson, readStdin } from './post.js'
import { claudeDir } from './token-totals.js'

const USER_TIMEOUT_MS = 5000
/** Set on the user's command so a status line that (indirectly) runs this wrapper again cannot loop. */
const GUARD_ENV = 'DSH_WT_STATUSLINE'
const SUBAGENT_GUARD_ENV = 'DSH_WT_SUBAGENTLINE'

/**
 * The user's own command under `key` ('statusLine' or 'subagentStatusLine') in their Claude settings.
 * @returns {{command: string, refreshInterval?: number} | undefined}
 */
function userCommand(key, env) {
  try {
    const line = JSON.parse(readFileSync(join(claudeDir(env), 'settings.json'), 'utf8'))?.[key]
    if (line?.type !== 'command' || typeof line.command !== 'string' || line.command.trim() === '') return undefined
    return { command: line.command, refreshInterval: typeof line.refreshInterval === 'number' ? line.refreshInterval : undefined }
  } catch {
    return undefined
  }
}

/** The user's own `statusLine` setting, if it is a command. */
export function userStatusLine(env = process.env) {
  return userCommand('statusLine', env)
}

/** The user's own `subagentStatusLine` setting, if it is a command. */
export function userSubagentStatusLine(env = process.env) {
  return userCommand('subagentStatusLine', env)
}

/** End `child` and everything it started: `shell: true` puts cmd.exe / sh between us and the real command. */
function killTree(child) {
  const single = () => { try { child.kill() } catch {} }
  try {
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      // Killing cmd.exe first would orphan its children before taskkill can walk the tree: only fall back to it on failure.
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', single)
      killer.on('close', (code) => { if (code !== 0) single() })
      return
    }
    if (Number.isInteger(child.pid)) process.kill(-child.pid, 'SIGKILL') // the child leads its own process group (see runUser)
  } catch {}
  single()
}

/** Run the user's command with `input` on stdin; resolves with its stdout ('' on any failure). */
export function runUser(command, input, guard, timeoutMs = USER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, { shell: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, [guard]: '1' } })
    } catch {
      return resolve('')
    }
    const out = []
    const timer = setTimeout(() => {
      killTree(child)
      // A grandchild that survives would hold the pipe open: stop listening to it.
      child.stdout.destroy()
      resolve(Buffer.concat(out).toString('utf8'))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(out).toString('utf8')) })
    child.stdin.end(input)
  })
}

async function main() {
  const input = await readStdin()
  const token = process.env.DSH_WT_TOKEN
  const subagents = process.argv[2] === '--subagents'
  const url = subagents ? process.argv[3] : process.argv[2]
  const guard = subagents ? SUBAGENT_GUARD_ENV : GUARD_ENV
  const user = process.env[guard] === '1' ? undefined : subagents ? userSubagentStatusLine() : userStatusLine()
  // Our own entry in the user's settings (or an echo of this file) would run us again: skip it.
  const runnable = user !== undefined && !user.command.includes('statusline.js')
  const [, output] = await Promise.all([
    token && url ? postJson(url, token, input) : undefined,
    runnable ? runUser(user.command, input, guard) : '',
  ])
  if (output) process.stdout.write(output)
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => { process.exitCode = 0 })
}
