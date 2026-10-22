// Detached relaunch helper for "Update from source" (lib/self-update.js).
//
// Usage: node relaunch.js <appPid> <hostPid> <appExe>
//
// Asks the app to close, forces it (and the host process, if it lingers) after a grace period, then starts
// the app executable again. Only the two given PIDs are ever signalled, never a process tree or an image
// name: this helper is itself a descendant of the app, and a tree kill would take it down too.
// Progress goes to <tmp>/dsh-wt-relaunch.log for when a restart does not come back.

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GRACE_MS = 8000
const HOST_GRACE_MS = 5000
const POLL_MS = 200

const logFile = join(tmpdir(), 'dsh-wt-relaunch.log')
const log = (line) => {
  try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) } catch {}
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitGone(pid, ms) {
  const deadline = Date.now() + ms
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  return !alive(pid)
}

/** Polite close: WM_CLOSE to the app's windows on Windows, SIGTERM elsewhere. */
function askToClose(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  else try { process.kill(pid, 'SIGTERM') } catch {}
}

/** TerminateProcess on Windows, SIGKILL elsewhere. */
function force(pid) {
  try { process.kill(pid, 'SIGKILL') } catch {}
}

const [appPid, hostPid] = process.argv.slice(2, 4).map((value) => Number.parseInt(value, 10))
const exe = process.argv[4]
if (!(appPid > 1) || !(hostPid > 1) || typeof exe !== 'string' || exe.length === 0) {
  log(`bad arguments: ${process.argv.slice(2).join(' ')}`)
  process.exit(2)
}

log(`relaunch: app ${appPid}, host ${hostPid}, exe ${exe}`)
askToClose(appPid)
if (!(await waitGone(appPid, GRACE_MS))) {
  log('app did not close in time, forcing it')
  force(appPid)
  await waitGone(appPid, 3000)
}
if (!(await waitGone(hostPid, HOST_GRACE_MS))) {
  log('host outlived the app, forcing it')
  force(hostPid)
  await waitGone(hostPid, 3000)
}
// A moment for the single-instance lock and the server port to be released.
await new Promise((resolve) => setTimeout(resolve, 1000))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const app = spawn(exe, [], { detached: true, stdio: 'ignore', env })
  app.on('error', (error) => log(`start failed: ${error.message}`))
  app.unref()
  log(`started ${exe}`)
} catch (error) {
  log(`start failed: ${error instanceof Error ? error.message : String(error)}`)
}
