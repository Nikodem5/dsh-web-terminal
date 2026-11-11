// dsh-web-terminal — git status for the window header (host half).
//
// For each local terminal the host works out `{ branch, dirty }` of the terminal's folder and
// tells the attached browser (`{ type: 'git', git }`). Nothing here blocks: git runs as an async
// child process with a timeout, at most a few at once, and a terminal is looked at only
//   - when the browser asks (`request`: a command ended, the folder changed, the page attached),
//   - when its agent goes quiet (`signal`: finished / idle / failed / ended),
//   - on one slow interval for terminals a browser is attached to.
// Requests for one terminal are spaced by `minGapMs` (a burst becomes one trailing run), and a
// terminal that is gone (`forget`) leaves no timer behind. ssh terminals are never looked at:
// their folder is on another machine.

import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

/** Branch names are shown in a header chip; anything longer than a ref can be is not a branch. */
const BRANCH_MAX = 200
/** Longest folder path accepted from a browser. */
const CWD_MAX = 1024
/** Largest `git status` output read (bytes); a repo with more changed files than fit is dirty anyway. */
const OUTPUT_MAX = 1024 * 1024

/**
 * Read the branch and dirtiness out of `git status --porcelain=v2 --branch`.
 * Entry lines start with `1` (changed), `2` (renamed), `u` (unmerged) or `?` (untracked).
 * @param stdout - the command's output (may be cut short: the header lines come first).
 * @returns undefined when the text is not a branch listing.
 */
export function parseStatus(stdout) {
  let branch
  let oid
  let dirty = false
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim()
    else if (line.length > 0 && line[0] !== '#' && '12u?'.includes(line[0])) dirty = true
  }
  if (branch === undefined || branch.length === 0) return undefined
  if (branch === '(detached)') {
    const short = oid !== undefined && oid !== '(initial)' ? oid.slice(0, 7) : 'HEAD'
    return { branch: short, dirty, detached: true }
  }
  return { branch: branch.length > BRANCH_MAX ? branch.slice(0, BRANCH_MAX) : branch, dirty }
}

/** The arguments of the status call: no optional index lock (a user's own git command must not wait on us) and no fsmonitor hook. */
export const STATUS_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch']

/** Run git once: resolves `{ code, stdout }`, never rejects (a spawn failure is `code: null`). */
function defaultRun(file, args, options) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: OUTPUT_MAX,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        },
        (error, stdout) => {
          if (error === null) return resolve({ code: 0, stdout })
          // Output past the limit: the head of it (branch lines, first entries) is all that is needed.
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ code: 0, stdout: String(stdout ?? '') })
          resolve({ code: typeof error.code === 'number' ? error.code : null, stdout: '' })
        },
      )
    } catch {
      resolve({ code: null, stdout: '' })
    }
  })
}

/** Whether a browser-supplied folder is something worth handing to git. */
export function usableCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && cwd.length <= CWD_MAX && !cwd.includes('\0') && isAbsolute(cwd)
}

const same = (a, b) => (a === null || b === null ? a === b : a.branch === b.branch && a.dirty === b.dirty && a.detached === b.detached)

/**
 * @param deps.which - finds `git` on PATH (async, returns a path or undefined).
 * @param deps.send - `(session, frame)` delivers one frame to the session's attached browser (and does nothing when none).
 * @param deps.attached - `(session)` whether a browser is attached.
 * @param deps.run - replaceable git runner (tests).
 * @param deps.setTimer / deps.clearTimer - replaceable timers (tests).
 */
export function createGitHeader({
  which,
  send,
  attached,
  run = defaultRun,
  intervalMs = 30_000,
  minGapMs = 2000,
  timeoutMs = 8000,
  maxConcurrent = 3,
  missingRetryMs = 60_000,
}) {
  /** session -> { cwd, value (last result: object | null | undefined = unknown), sent, running, again, timer, at } */
  const tracked = new Map()
  let disposed = false
  let gitPath
  let gitMissingAt = 0
  let active = 0
  const waiting = []

  /** Run `task` when fewer than `maxConcurrent` git processes are going. */
  const slot = (task) => {
    if (active >= maxConcurrent) {
      waiting.push(task)
      return
    }
    active++
    task().finally(() => {
      active--
      const next = waiting.shift()
      if (next !== undefined) slot(next)
    })
  }

  const findGit = async () => {
    if (gitPath !== undefined) return gitPath
    if (gitMissingAt !== 0 && Date.now() - gitMissingAt < missingRetryMs) return undefined
    gitPath = await which('git')
    gitMissingAt = gitPath === undefined ? Date.now() : 0
    return gitPath
  }

  /** Look the folder up now; the result is sent only when it differs from what the browser already has. */
  const execute = async (session, state) => {
    state.running = true
    state.again = false
    state.at = Date.now()
    let value = null
    const cwd = state.cwd
    try {
      const file = await findGit()
      if (file !== undefined && !disposed) {
        const result = await new Promise((resolve) => slot(async () => resolve(await run(file, STATUS_ARGS, { cwd, timeoutMs }))))
        value = result.code === 0 ? (parseStatus(result.stdout) ?? null) : null
      }
    } catch {
      value = null
    }
    state.running = false
    if (disposed || tracked.get(session) !== state) return
    // The folder changed while git ran: this answer is for the old one.
    if (state.cwd !== cwd) state.again = true
    else {
      state.value = value
      if (!state.sent || !same(state.sentValue, value)) {
        state.sent = true
        state.sentValue = value
        send(session, { type: 'git', git: value })
      }
    }
    if (state.again) schedule(session, state)
  }

  /** Run now, or after the gap since the last run, or once the run in flight is over. */
  const schedule = (session, state) => {
    if (disposed || state.running) {
      state.again = true
      return
    }
    if (state.timer !== null) return
    const wait = state.at + minGapMs - Date.now()
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = null
        if (tracked.get(session) === state) schedule(session, state)
      }, wait)
      state.timer.unref?.()
      return
    }
    void execute(session, state)
  }

  const stateOf = (session) => {
    let state = tracked.get(session)
    if (state === undefined) {
      state = { cwd: session.cwd, value: undefined, sent: false, sentValue: null, running: false, again: false, timer: null, at: 0 }
      tracked.set(session, state)
    }
    return state
  }

  const eligible = (session) => session.shellId !== 'ssh' && !session.exited

  const slow = setInterval(() => {
    for (const [session, state] of tracked) if (eligible(session) && attached(session)) schedule(session, state)
  }, intervalMs)
  slow.unref?.()

  return {
    /**
     * The browser asks for a refresh: a command ended, the folder changed, or it just attached.
     * @param cwd - the folder the shell reports now (ignored unless it is an absolute path); the start folder is used until one arrives.
     */
    request(session, cwd) {
      if (disposed || !eligible(session)) return
      const state = stateOf(session)
      if (usableCwd(cwd)) state.cwd = cwd
      if (!usableCwd(state.cwd)) return
      schedule(session, state)
    },
    /** The terminal's agent changed state; it is quiet (or gone) now, so the folder may have changed. */
    signal(session, agentState) {
      if (agentState === 'working' || agentState === 'needs-you') return
      this.request(session)
    },
    /** A browser attached: repeat what it was last told (it may have missed it), then look again. */
    attach(session) {
      if (disposed || !eligible(session)) return
      const state = stateOf(session)
      state.sent = false
      if (state.value !== undefined) {
        state.sent = true
        state.sentValue = state.value
        send(session, { type: 'git', git: state.value })
      }
      this.request(session)
    },
    /** The terminal is gone. */
    forget(session) {
      const state = tracked.get(session)
      if (state === undefined) return
      clearTimeout(state.timer)
      tracked.delete(session)
    },
    /** Number of terminals being tracked (tests). */
    get size() {
      return tracked.size
    },
    dispose() {
      disposed = true
      clearInterval(slow)
      for (const state of tracked.values()) clearTimeout(state.timer)
      tracked.clear()
      waiting.length = 0
    },
  }
}
