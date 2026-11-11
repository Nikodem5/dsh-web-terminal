// dsh-web-terminal — Antigravity CLI status-line wrapper (runs inside agy, not the host).
//
// With the integration on, a terminal starts `agy --settings <file>` whose `statusLine` runs this script.
// agy runs it on every agent state change with its status-line JSON on stdin. It:
//  1. POSTs the JSON to <DSH_WT_AGY_SIGNAL>/antigravity-status with the terminal's secret, which gives the
//     host the conversation id, a trusted agent state and the quota / cost / token numbers;
//  2. runs the user's own status line (from <gemini dir>/antigravity-cli/settings.json, which our
//     `--settings` overrides for the session) and relays its output, so what they see does not change.
// Silent: it never prints errors and always exits 0.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postJson, readStdin } from './post.js'

const USER_TIMEOUT_MS = 4000
/** Set on the user's command so a status line that runs this wrapper again cannot loop. */
const GUARD_ENV = 'DSH_WT_AGY_STATUSLINE'

/** agy's config folder (DSH_WT_GEMINI_DIR overrides it, for tests). */
export function geminiDir(env = process.env) {
  return env.DSH_WT_GEMINI_DIR || join(homedir(), '.gemini')
}

/**
 * The user's own `statusLine` from agy's settings, when it is an enabled command.
 * @returns {{command: string, padding?: number, stackWithDefault?: boolean} | undefined}
 */
export function userAgyStatusLine(env = process.env) {
  try {
    const line = JSON.parse(readFileSync(join(geminiDir(env), 'antigravity-cli', 'settings.json'), 'utf8'))?.statusLine
    if (line === null || typeof line !== 'object' || line.enabled === false) return undefined
    if ((line.type ?? 'command') !== 'command' || typeof line.command !== 'string' || line.command.trim() === '') return undefined
    return {
      command: line.command,
      padding: typeof line.padding === 'number' ? line.padding : undefined,
      stackWithDefault: typeof line.stack_with_default === 'boolean' ? line.stack_with_default : undefined,
    }
  } catch {
    return undefined
  }
}

/** Run the user's command with `input` on stdin; resolves with its stdout ('' on any failure). */
function runUser(command, input) {
  // agy expands a leading `~` itself; do the same, since the command now runs from here.
  const expanded = command.startsWith('~') ? join(homedir(), command.slice(1)) : command
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(expanded, { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, [GUARD_ENV]: '1' } })
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

async function main() {
  const input = await readStdin()
  const base = process.env.DSH_WT_AGY_SIGNAL
  const token = process.env.DSH_WT_TOKEN
  const user = process.env[GUARD_ENV] === '1' ? undefined : userAgyStatusLine()
  const runnable = user !== undefined && !user.command.includes('agy-statusline')
  const [, output] = await Promise.all([
    token && base ? postJson(`${base}/antigravity-status`, token, input) : undefined,
    runnable ? runUser(user.command, input) : '',
  ])
  if (output) process.stdout.write(output)
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => { process.exitCode = 0 })
}
