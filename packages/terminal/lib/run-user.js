// dsh-web-terminal — runs a user's own status-line command for the wrappers (statusline.js for Claude Code,
// agy-statusline.mjs for Antigravity), with a timeout that ends the whole process tree.

import { spawn } from 'node:child_process'

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
export function runUser(command, input, guard, timeoutMs) {
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
