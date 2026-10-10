// OS process-table snapshots for the "is something running under the shell" poll.
//
// On Windows the table comes from one long-lived PowerShell helper instead of a fresh
// `powershell Get-CimInstance` every few seconds (a whole PowerShell start-up per poll is costly on
// a laptop). The helper is started on the first request, asked for a snapshot per poll over a line
// protocol, and stopped again once nobody asks for a while. Elsewhere `ps` is used, unchanged.
//
// Protocol: the host writes `snapshot\n`; the helper answers with exactly one line of compact JSON,
// `[{"p":pid,"q":ppid,"n":"name"},...]`, and exits on `exit` or stdin EOF.

import { execFile, spawn } from 'node:child_process'

/** Stop the helper after this long without a request (polling only runs while a terminal is attached). */
const IDLE_MS = 30_000
/** A snapshot (including helper start-up on the first one) must arrive within this long. */
const TIMEOUT_MS = 10_000
/** Buffered output beyond this without a newline is garbage; the helper is restarted. */
const MAX_LINE = 16 * 1024 * 1024
/** First restart delay after a failure; doubles per consecutive failure up to BACKOFF_MAX_MS. */
const BACKOFF_MS = 3000
const BACKOFF_MAX_MS = 60_000

/** The helper's script: one JSON line per `snapshot` line. */
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  if ($line -ne 'snapshot') { continue }
  try {
    $rows = @(Get-CimInstance Win32_Process | ForEach-Object { @{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId; n = [string]$_.Name } })
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $rows))
  } catch {
    [Console]::Out.WriteLine('[]')
  }
  [Console]::Out.Flush()
}
`

/** Spawn the real PowerShell helper (-EncodedCommand avoids every quoting problem). */
function spawnPowerShellHelper() {
  const encoded = Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

/** Add one process to a parent pid -> [{pid, name}] map. */
function addChild(children, pid, ppid, name) {
  const list = children.get(ppid) ?? []
  list.push({ pid, name: String(name).toLowerCase() })
  children.set(ppid, list)
}

/**
 * Parse the helper's JSON line.
 * @returns the map, or undefined when the line is not a process array.
 */
function parseSnapshot(line) {
  let rows
  try {
    rows = JSON.parse(line.replace(/^﻿/, ''))
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  const children = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || !Number.isInteger(row.p) || !Number.isInteger(row.q) || typeof row.n !== 'string') continue
    addChild(children, row.p, row.q, row.n)
  }
  return children
}

/** `ps` snapshot for Linux/macOS: one short-lived process per poll. */
function psSnapshot() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) return resolve(undefined)
      const children = new Map()
      for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if (match !== null) addChild(children, Number(match[1]), Number(match[2]), match[3])
      }
      resolve(children)
    })
  })
}

/**
 * Create a process-table reader; one per plugin instance so dispose can stop its helper.
 * @param options - overrides for tests: platform, spawnHelper, idleMs, timeoutMs, backoffMs, now.
 * @returns `snapshot()` (parent pid -> [{pid, name}], or undefined on failure), `stop()` and `running()`.
 */
function createProcessTable(options = {}) {
  const platform = options.platform ?? process.platform
  const spawnHelper = options.spawnHelper ?? spawnPowerShellHelper
  const idleMs = options.idleMs ?? IDLE_MS
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const backoffMs = options.backoffMs ?? BACKOFF_MS
  const now = options.now ?? Date.now

  /** The live helper: {child, buffer, pending: {resolve, timer} | null}. */
  let helper = null
  let failures = 0
  let retryAt = 0
  let idleTimer = null
  let stopped = false
  let inflight = null

  /** Record a failure: the next start waits longer each consecutive time. */
  function noteFailure() {
    failures++
    retryAt = now() + Math.min(BACKOFF_MAX_MS, backoffMs * 2 ** (failures - 1))
  }

  /** Kill the helper and answer any waiting request with `undefined`. */
  function teardown(failed) {
    const current = helper
    helper = null
    if (current === null) return
    if (current.pending !== null) {
      clearTimeout(current.pending.timer)
      current.pending.resolve(undefined)
      current.pending = null
    }
    try { current.child.stdin?.end() } catch {}
    try { current.child.kill() } catch {}
    if (failed) noteFailure()
  }

  function start() {
    const child = spawnHelper()
    const current = { child, buffer: '', pending: null }
    helper = current
    const fail = () => { if (helper === current) teardown(true) }
    child.on?.('error', fail)
    child.on?.('exit', fail)
    child.on?.('close', fail)
    child.stdin?.on?.('error', fail)
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => {
      if (helper !== current) return
      current.buffer += String(chunk)
      // A line is complete only up to its newline; a partial tail waits for more data.
      let newline
      while ((newline = current.buffer.indexOf('\n')) !== -1) {
        const line = current.buffer.slice(0, newline).trim()
        current.buffer = current.buffer.slice(newline + 1)
        if (line.length === 0 || current.pending === null) continue
        const children = parseSnapshot(line)
        if (children === undefined) continue
        const { resolve, timer } = current.pending
        clearTimeout(timer)
        current.pending = null
        failures = 0
        resolve(children)
      }
      if (current.buffer.length > MAX_LINE) fail()
    })
  }

  function request() {
    return new Promise((resolve) => {
      if (stopped) return resolve(undefined)
      if (helper === null) {
        if (now() < retryAt) return resolve(undefined)
        try {
          start()
        } catch {
          noteFailure()
          return resolve(undefined)
        }
      }
      const current = helper
      const timer = setTimeout(() => { if (helper === current) teardown(true) }, timeoutMs)
      current.pending = { resolve, timer }
      try {
        current.child.stdin.write('snapshot\n')
      } catch {
        teardown(true)
      }
    })
  }

  return {
    /** @returns parent pid -> [{pid, name}], or undefined when the query failed or is backing off. */
    snapshot() {
      if (platform !== 'win32') return psSnapshot()
      if (inflight !== null) return inflight
      clearTimeout(idleTimer)
      inflight = request().finally(() => {
        inflight = null
        if (stopped) return
        idleTimer = setTimeout(() => teardown(false), idleMs)
        idleTimer.unref?.()
      })
      return inflight
    },
    /** Kill the helper for good (plugin dispose). */
    stop() {
      stopped = true
      clearTimeout(idleTimer)
      teardown(false)
    },
    /** Whether a helper process is currently alive. */
    running() {
      return helper !== null
    },
  }
}

export { createProcessTable, parseSnapshot, HELPER_SCRIPT }
