// Test harness: a STRICT cordis-like ctx (reading anything not injected throws), a real HTTP server that dispatches
// the registered exact routes and upgrades, temp dirs and temp git repos.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { apply } from '../../lib/index.js'

export const cleanups = []
export async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn()
    } catch {}
  }
}

export function tempDir(prefix = 'dsh-ce-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  return dir
}

/** Poll until `fn` returns a truthy value; returns early, fails after `timeout`. */
export async function waitFor(fn, { timeout = 20_000, label = 'condition' } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

export function strictCtx(base) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

/** Start the plugin behind a real HTTP server. */
export async function startHost(options = {}) {
  const dir = options.dir ?? tempDir('dsh-ce-data-')
  const routes = new Map()
  const upgrades = []
  const teardowns = []
  const order = []
  const ctx = strictCtx({
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        order.push(`register ${route.path}`)
        return () => routes.delete(route.path)
      },
      registerUpgrade: (route) => {
        upgrades.push(route)
        order.push('upgrade')
        return () => {}
      },
    },
    effect: (fn) => {
      teardowns.push(fn())
      return () => {}
    },
  })
  apply(ctx, { dir, debounceMs: 40, idleMs: 200, pollMs: 100, ...options })
  const http = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://x').pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    route.handler(req, res)
  })
  http.on('upgrade', (req, socket, head) => {
    const route = upgrades.find((u) => u.path === new URL(req.url, 'http://x').pathname)
    if (route === undefined) return socket.destroy()
    route.handler(req, socket, head)
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const port = http.address().port
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const t of teardowns) t()
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
  }
  cleanups.push(stop)

  const host = {
    port,
    dir,
    routes,
    order,
    stop,
    async call(method, path, { query, body, headers, rawBody, contentType = 'application/json' } = {}) {
      const url = new URL(`http://127.0.0.1:${port}/api/dsh-code-editor${path}`)
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
      const response = await fetch(url, {
        method,
        headers: { ...(body !== undefined || rawBody !== undefined ? { 'content-type': contentType } : {}), ...headers },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      })
      return { status: response.status, json: await response.json(), headers: response.headers }
    },
    get: (path, query, headers) => host.call('GET', path, { query, headers }),
    post: (path, body, headers) => host.call('POST', path, { body, headers }),
    put: (path, body, headers) => host.call('PUT', path, { body, headers }),
    async register(...roots) {
      const result = await host.post('/roots', { roots })
      return result
    },
    /** Open a socket and collect frames. */
    async socket(root, { origin, path = '/code-editor/ws' } = {}) {
      const url = `ws://127.0.0.1:${port}${path}?root=${encodeURIComponent(root)}`
      const ws = new WebSocket(url, origin === undefined ? undefined : { origin })
      const frames = []
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
      const opened = new Promise((resolve, reject) => {
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
        ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })))
      })
      cleanups.push(() => ws.terminate())
      return { ws, frames, opened, close: () => ws.close() }
    },
  }
  return host
}

export function git(cwd, ...args) {
  const out = run(cwd, args)
  // Deterministic checkouts regardless of the machine's global autocrlf.
  if (args[0] === 'init') run(cwd, ['config', 'core.autocrlf', 'false'])
  return out
}

function run(cwd, args) {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true })
}

/** Write files (relative path -> content) below a dir. */
export function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** A temp git repo with an initial commit. */
export function tempRepo(files = { 'a.txt': 'one\n' }) {
  const dir = tempDir('dsh-ce-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
