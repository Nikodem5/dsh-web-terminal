// dsh-code-editor host half: confined file + git routes and a live-update WebSocket for the Monaco client.
// The contract is docs/API.md. Security model: README.md.
//
// A real cordis ctx THROWS on any property that is not in `inject`, so this file touches ctx.webServer and
// ctx.effect only.
import { promises as fsp } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { WebSocketServer } from 'ws'
import { EditorError, fromFsError } from './errors.js'
import { splitRelative } from './confine.js'
import { createRoots, dataDir, validateRoot } from './roots.js'
import { MAX_LIST_FILES, MAX_WRITE_BYTES, listTree, readFile, walkFiles, writeFile } from './files.js'
import * as gitOps from './git.js'
import { gitToolRoutes } from './git-tools.js' // git tools block: commit, branches, history, sync
import { findRepos } from './repos.js'
import { createWatchers } from './watcher.js'
import { RAW, searchRoutes } from './search-routes.js'
import { originAllowed, parseExtraOrigins } from './shared/origin.js'
import { safeCall } from './shared/safe-call.js'

/** Stable cordis plugin name. */
const name = 'code-editor'

/** Services required: the web server only (git runs through child_process.execFile). */
const inject = ['webServer']

const API = '/api/dsh-code-editor'
const WS_PATH = '/code-editor/ws'
const JSON_BODY_LIMIT = 256 * 1024
const MAX_SOCKETS = 64
const HEARTBEAT_MS = 30_000
const REPOS_TTL_MS = 10_000
const REPOS_CACHE_MAX = 32

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/** Read a JSON object body, refusing anything but application/json (forces a CORS preflight for foreign pages). */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') return reject(new EditorError(415, 'bad-request', 'Content-Type must be application/json'))
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      return reject(new EditorError(413, 'too-large', 'Body too large'))
    }
    const chunks = []
    let size = 0
    let big = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) big = true
      else chunks.push(chunk)
    })
    req.on('error', () => reject(new EditorError(400, 'bad-request', 'Request aborted')))
    req.on('end', () => {
      if (big) return reject(new EditorError(413, 'too-large', 'Body too large'))
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape')
        resolve(body)
      } catch {
        reject(new EditorError(400, 'bad-request', 'Bad JSON'))
      }
    })
  })
}

const knownNumbers = ['debounceMs', 'idleMs', 'pollMs']
const knownModes = ['recursive', 'fallback']

/**
 * Apply the plugin.
 * @param ctx - host plugin context carrying webServer.
 * @param options - test hooks only: debounceMs, idleMs, pollMs, mode, dir (data dir), probe(internals).
 */
function apply(ctx, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const watchOptions = {}
  for (const key of knownNumbers) if (Number.isFinite(opts[key])) watchOptions[key] = opts[key]
  if (knownModes.includes(opts.mode)) watchOptions.mode = opts.mode
  const extraOrigins = [...parseExtraOrigins(process.env.DSH_CE_ALLOWED_ORIGINS), ...parseExtraOrigins(process.env.DSH_WT_ALLOWED_ORIGINS)]
  const dir = typeof opts.dir === 'string' ? opts.dir : dataDir()
  const roots = createRoots(join(dir, 'roots.json'))
  const watchers = createWatchers(watchOptions)
  if (typeof opts.probe === 'function') safeCall(() => opts.probe({ watchers }))
  let disposed = false

  /** Wrap an optional piece so one failure cannot break the others. */
  const optional = (label, fn) => {
    try {
      return fn()
    } catch (error) {
      console.warn(`[code-editor] ${label} unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Resolve the request's registered root. */
  const rootOf = async (value) => {
    if (typeof value !== 'string' || value === '') throw new EditorError(400, 'bad-request', 'root is required')
    await roots.revalidate()
    const found = await roots.find(value)
    if (found === undefined) throw new EditorError(403, 'root', 'Root is not registered')
    return found
  }

  /**
   * Register one exact route. `handlers` maps an HTTP method to `async ({ url, body, req }) => json`.
   * Body methods (POST/PUT) get a parsed JSON body, with `bodyLimit` bytes.
   */
  const route = (path, handlers, bodyLimit = JSON_BODY_LIMIT) =>
    optional(`route ${path}`, () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}${path}`,
        handler: async (req, res) => {
          try {
            if (!originAllowed(req.headers.origin, req.headers.host, extraOrigins)) throw new EditorError(403, 'origin', 'Origin not allowed')
            const handler = handlers[req.method ?? '']
            if (handler === undefined) {
              res.setHeader?.('allow', Object.keys(handlers).join(', '))
              throw new EditorError(405, 'method', 'Method not allowed')
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readJsonBody(req, bodyLimit)
            const out = await handler({ url, body, req, res })
            // search-routes.js: a binary answer (images for the markdown preview) instead of JSON.
            if (out?.[RAW] !== undefined) {
              res.writeHead(out[RAW].status, out[RAW].headers)
              res.end(out[RAW].body)
            } else writeJson(res, 200, { ok: true, ...out })
          } catch (error) {
            const failure = error instanceof EditorError ? error : fromFsError(error)
            if (!(error instanceof EditorError) && failure.status === 500) console.warn(`[code-editor] ${path}: ${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) writeJson(res, failure.status, { ok: false, error: failure.message, code: failure.code, ...failure.extra })
          }
        },
      }),
    )

  /** real root -> { at, value }: nested-repo scans are cheap but not free, and the sidebar asks often. */
  const repoCache = new Map()

  const param = (url, key) => url.searchParams.get(key) ?? ''
  const gitReady = (body) => rootOf(body?.root)

  const disposers = [
    route('/roots', {
      POST: async ({ body }) => {
        if (!Array.isArray(body.roots) || body.roots.length > 256) throw new EditorError(400, 'bad-request', 'roots must be an array of at most 256 strings')
        await roots.revalidate()
        const rejected = await roots.register(body.roots)
        const list = await Promise.all(
          roots.list().map(async (path) => {
            const found = await roots.find(path)
            let exists = false
            let isGit = false
            if (found !== undefined) {
              exists = true
              try {
                isGit = (await gitOps.repoInfo(found.path)).inside
              } catch {}
            }
            return { path, exists, isGit }
          }),
        )
        return { roots: list, rejected }
      },
    }),
    // The root a path outside every registered root should get: git top-level, else the folder. Registers nothing.
    route('/resolve', {
      GET: async ({ url }) => {
        const raw = param(url, 'path')
        if (raw === '' || raw.length > 1024 || /[\u0000-\u001f]/.test(raw) || !isAbsolute(raw)) throw new EditorError(400, 'bad-request', 'path must be an absolute path')
        let stat
        try {
          stat = await fsp.stat(raw)
        } catch (error) {
          throw fromFsError(error)
        }
        const dir = stat.isDirectory() ? resolvePath(raw) : dirname(resolvePath(raw))
        let top = null
        try {
          top = await gitOps.topLevel(dir)
        } catch (error) {
          if (!(error instanceof EditorError) || !['no-git', 'timeout'].includes(error.code)) throw error
        }
        if (top !== null) {
          const checked = await validateRoot(resolvePath(top))
          if (checked.error === undefined) return { root: checked.path, isGit: true }
        }
        const checked = await validateRoot(dir)
        if (checked.error !== undefined) throw new EditorError(403, 'root', `Cannot use this folder as a root: ${checked.error}`)
        return { root: checked.path, isGit: top !== null }
      },
    }),
    route('/tree', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        const { entries } = await listTree(root.real, param(url, 'dir'))
        safeCall(() => watchers.touchDir(root.real, splitRelative(param(url, 'dir'), { allowEmpty: true }).join('/')))
        return { entries }
      },
    }),
    route('/files', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        if ((await gitOps.repoInfo(root.path)).inside) {
          try {
            return await gitOps.listFiles(root.path, MAX_LIST_FILES)
          } catch (error) {
            if (error instanceof EditorError && error.code === 'no-git') return walkFiles(root.real)
            throw error
          }
        }
        return walkFiles(root.real)
      },
    }),
    // --- search + raw image routes (search-routes.js) ---
    ...searchRoutes({ route, rootOf, timeoutMs: Number.isFinite(opts.searchTimeoutMs) ? opts.searchTimeoutMs : undefined }),
    // --- end search ---
    route(
      '/file',
      {
        GET: async ({ url }) => {
          const root = await rootOf(param(url, 'root'))
          return readFile(root.real, param(url, 'path'))
        },
        PUT: async ({ body }) => {
          const root = await rootOf(body.root)
          const result = await writeFile(root.real, body.path, body.content, body.expectedMtime === undefined ? NaN : body.expectedMtime)
          safeCall(() => watchers.notifyGit(root.real))
          return result
        },
      },
      MAX_WRITE_BYTES + 64 * 1024,
    ),
    // Repositories for the CHANGES view: the repo the root is inside of, else the repos nested below it.
    route('/git/repos', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        const hit = repoCache.get(root.real)
        if (param(url, 'fresh') !== '1' && hit !== undefined && Date.now() - hit.at < REPOS_TTL_MS) return hit.value
        let value
        if ((await gitOps.repoInfo(root.path)).inside) {
          // Inside a work tree: that repo, scoped to the root (the root is never widened to the work tree top).
          value = { inside: true, truncated: false, repos: [{ path: root.path, rel: '', name: basename(root.path) }] }
        } else {
          const found = await findRepos(root.path)
          value = { inside: false, truncated: found.truncated, repos: found.repos }
        }
        if (repoCache.size >= REPOS_CACHE_MAX) repoCache.delete(repoCache.keys().next().value)
        repoCache.set(root.real, { at: Date.now(), value })
        return value
      },
    }),
    route('/git/status', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        const { branch, ahead, behind, files, truncated } = await gitOps.status(root.path)
        return { branch, ahead, behind, files, truncated }
      },
    }),
    route('/git/diff', {
      GET: async ({ url }) => {
        const root = await rootOf(param(url, 'root'))
        const staged = param(url, 'staged')
        if (staged !== '0' && staged !== '1' && staged !== '') throw new EditorError(400, 'bad-request', 'staged must be 0 or 1')
        return gitOps.diff(root.path, root.real, param(url, 'path'), staged === '1')
      },
    }),
    route('/git/stage', {
      POST: async ({ body }) => {
        const root = await gitReady(body)
        await gitOps.stage(root.path, await gitOps.checkPaths(root.real, body.paths))
        safeCall(() => watchers.notifyGit(root.real))
        return {}
      },
    }),
    route('/git/unstage', {
      POST: async ({ body }) => {
        const root = await gitReady(body)
        await gitOps.unstage(root.path, await gitOps.checkPaths(root.real, body.paths))
        safeCall(() => watchers.notifyGit(root.real))
        return {}
      },
    }),
    route('/git/discard', {
      POST: async ({ body }) => {
        const root = await gitReady(body)
        const paths = await gitOps.checkPaths(root.real, body.paths ?? [], { required: false })
        const untracked = await gitOps.checkPaths(root.real, body.untracked ?? [], { required: false })
        if (paths.length === 0 && untracked.length === 0) throw new EditorError(400, 'bad-request', 'nothing to discard')
        await gitOps.discard(root.path, root.real, paths, untracked)
        safeCall(() => watchers.notifyGit(root.real))
        return {}
      },
    }),
    // git tools block: commit, branches, history, sync (lib/git-tools.js)
    ...gitToolRoutes({ route, rootOf, changed: (root) => safeCall(() => watchers.notifyGit(root.real)) }),
  ]

  // WebSocket: connection listener first, upgrade route registered last (an upgrade must never reach a server
  // nobody listens on).
  const server = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  const beat = setInterval(() => {
    for (const client of server.clients) {
      if (client.isAlive === false) {
        client.terminate()
        continue
      }
      client.isAlive = false
      try {
        client.ping()
      } catch {}
    }
  }, HEARTBEAT_MS)
  beat.unref?.()

  server.on('connection', (ws, _req, info) => {
    ws.isAlive = true
    ws.on('pong', () => {
      ws.isAlive = true
    })
    const send = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }
    const release = watchers.acquire(info.real, info.isGit, send)
    const done = () => safeCall(release)
    ws.on('close', done)
    ws.on('error', done)
    ws.on('message', () => {})
    send({ type: 'hello', root: info.path })
  })

  const reject = (socket, status, text) => {
    socket.on('error', () => {})
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
  }

  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      socket.on('error', () => {})
      if (!originAllowed(req.headers.origin, req.headers.host, extraOrigins)) return reject(socket, 403, 'Forbidden')
      if (disposed || server.clients.size >= MAX_SOCKETS) return reject(socket, 503, 'Service Unavailable')
      const url = new URL(req.url ?? '/', 'http://localhost')
      rootOf(url.searchParams.get('root') ?? '')
        .then(async (root) => {
          let isGit = false
          try {
            isGit = (await gitOps.repoInfo(root.path)).inside
          } catch {}
          if (disposed) return reject(socket, 503, 'Service Unavailable')
          server.handleUpgrade(req, socket, head, (ws) => server.emit('connection', ws, req, { path: root.path, real: root.real, isGit }))
        })
        .catch((error) => reject(socket, error instanceof EditorError && error.status === 400 ? 400 : 403, error instanceof EditorError && error.status === 400 ? 'Bad Request' : 'Forbidden'))
    },
  })

  ctx.effect(() => () => {
    disposed = true
    clearInterval(beat)
    for (const dispose of disposers) safeCall(dispose)
    safeCall(disposeUpgrade)
    safeCall(() => watchers.dispose())
    for (const client of server.clients) safeCall(() => client.terminate())
    safeCall(() => server.close())
  }, 'code-editor: routes and watchers')
}

export { name, inject, apply }
export default { name, inject, apply }
