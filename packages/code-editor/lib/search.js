// Search in files. Git roots: `git grep` (tracked + untracked, never ignored files) streamed and killed at the caps;
// other roots: a walk. Regular-expression work runs in a worker thread (terminated on timeout). The route is in
// search-routes.js, the contract in API.md.
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { EditorError } from './errors.js'
import { locateHits } from './search-core.js'
import { MAX_FILES, gitPathspecs, normalizeParams } from './search-match.js'

export const SEARCH_TIMEOUT_MS = 10_000
const WORKER_URL = new URL('./search-worker.js', import.meta.url)
const GIT_BASE = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off']

/** Run a job in a worker; resolves `{ results, truncated, timedOut }` (partial results on timeout/abort). */
function runWorker(job, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let partial = []
    let finished = false
    const worker = new Worker(WORKER_URL, { workerData: job })
    const finish = (value, error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      worker.terminate().catch(() => {})
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish({ results: partial, truncated: true, timedOut: true }), Math.max(1, timeoutMs))
    const onAbort = () => finish({ results: partial, truncated: true, timedOut: false })
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message) => {
      if (message.type === 'progress') partial = message.results
      else if (message.type === 'done') finish({ results: message.results, truncated: message.truncated, timedOut: false })
      else if (message.type === 'error') finish(undefined, new EditorError(500, 'search', message.message))
    })
    worker.on('error', (error) => finish(undefined, new EditorError(500, 'search', String(error?.message ?? error))))
    worker.on('exit', () => finish({ results: partial, truncated: true, timedOut: false }))
  })
}

/**
 * Stream `git grep`; resolves the raw hits (one per matching line).
 * @returns `{ hits, truncated, timedOut, noPcre }`
 */
function gitGrep(cwd, params, { pcre, timeoutMs, signal }) {
  const { q, regex, caseSensitive, word, include, exclude, max } = params
  const args = [...GIT_BASE, 'grep', '-n', '--column', '-I', '-z', '--no-color', '--untracked', '--exclude-standard']
  if (!caseSensitive) args.push('-i')
  if (word) args.push('-w')
  args.push(regex ? (pcre ? '-P' : '-E') : '-F', '-e', q, '--', ...gitPathspecs(include, exclude))
  return new Promise((resolve, reject) => {
    const hits = []
    const files = new Set()
    let rest = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let killed = false
    let child
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_PAGER: 'cat' },
      })
    } catch (error) {
      return reject(new EditorError(501, 'no-git', String(error?.message ?? error)))
    }
    const stop = () => {
      if (killed) return
      killed = true
      child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      truncated = true
      stop()
    }, Math.max(1, timeoutMs))
    const onAbort = () => {
      truncated = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const take = (line) => {
      // path \0 line \0 col \0 text
      const a = line.indexOf('\0')
      const b = line.indexOf('\0', a + 1)
      const c = line.indexOf('\0', b + 1)
      if (a < 0 || b < 0 || c < 0) return
      const path = line.slice(0, a)
      if (!files.has(path)) {
        if (files.size >= MAX_FILES) {
          truncated = true
          return stop()
        }
        files.add(path)
      }
      hits.push({ path, line: Number(line.slice(a + 1, b)), byteCol: Number(line.slice(b + 1, c)), text: line.slice(c + 1) })
      if (hits.length >= max) {
        truncated = true
        stop()
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (killed) return
      rest += chunk
      let nl
      while (!killed && (nl = rest.indexOf('\n')) >= 0) {
        take(rest.slice(0, nl))
        rest = rest.slice(nl + 1)
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error?.code === 'ENOENT' ? new EditorError(501, 'no-git', 'git is not installed or not on PATH') : new EditorError(500, 'git', String(error?.message ?? error)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (!killed && rest.length > 0) take(rest)
      if (!killed && code !== 0 && code !== 1) {
        if (regex && pcre && /pcre|perl-regexp/i.test(stderr)) return resolve({ noPcre: true, hits: [], truncated: false, timedOut: false })
        const first = stderr.split(/\r?\n/).find((l) => l.trim() !== '') ?? 'git grep failed'
        return reject(new EditorError(400, 'bad-pattern', first.replace(/^fatal:\s*/, '').slice(0, 300)))
      }
      resolve({ hits, truncated, timedOut, noPcre: false })
    })
  })
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/**
 * Search a root.
 * @param root - `{ path, real, isGit }` (`path` = git cwd, `real` = confined real path for the walk).
 * @param query - raw parameters (see normalizeParams).
 * @param options.timeoutMs - total budget (default 10 s). options.signal - abort (client went away).
 * @returns `{ results, truncated, timedOut, took }`
 */
export async function searchRoot(root, query, { timeoutMs = SEARCH_TIMEOUT_MS, signal } = {}) {
  const params = normalizeParams(query)
  const started = Date.now()
  const left = () => Math.max(1, timeoutMs - (Date.now() - started))
  const finish = (value) => ({ results: value.results.sort(byPath), truncated: value.truncated, timedOut: value.timedOut === true, took: Date.now() - started })

  if (root.isGit) {
    let grep
    try {
      grep = await gitGrep(root.path, params, { pcre: true, timeoutMs: left(), signal })
      if (grep.noPcre) grep = await gitGrep(root.path, params, { pcre: false, timeoutMs: left(), signal })
    } catch (error) {
      if (!(error instanceof EditorError) || error.code !== 'no-git') throw error
      grep = null
    }
    if (grep !== null) {
      if (!params.regex) {
        // Literal: cheap enough for the main thread.
        const found = locateHits(grep.hits, params)
        return finish({ results: found.results, truncated: grep.truncated || found.truncated, timedOut: grep.timedOut })
      }
      const located = await runWorker({ type: 'locate', hits: grep.hits, params }, { timeoutMs: left(), signal })
      return finish({ results: located.results, truncated: grep.truncated || located.truncated, timedOut: grep.timedOut || located.timedOut })
    }
  }
  const walked = await runWorker({ type: 'walk', rootReal: root.real, params }, { timeoutMs: left(), signal })
  return finish(walked)
}
