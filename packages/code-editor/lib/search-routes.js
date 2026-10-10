// Routes added by the search / markdown-preview work: GET /search and GET /raw (see API.md). Registered from index.js
// through its `route` helper and `rootOf`, so origin checks, root confinement and error mapping are shared.
import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import { EditorError, fromFsError } from './errors.js'
import { resolveInside, splitRelative } from './confine.js'
import * as gitOps from './git.js'
import { searchRoot } from './search.js'

export const MAX_RAW_BYTES = 5 * 1024 * 1024
/** Image types the raw route serves (the markdown preview shows them in <img>); anything else is 415. */
export const RAW_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}
/** Marker: a handler returning `{ [RAW]: { status, headers, body } }` is written as-is instead of as JSON. */
export const RAW = Symbol('raw-response')

const flag = (url, key) => url.searchParams.get(key) === '1'

/**
 * @param helpers.route - index.js `route(path, handlers)`; helpers.rootOf - registered root lookup.
 * @param helpers.timeoutMs - search budget override (tests).
 */
export function searchRoutes({ route, rootOf, timeoutMs }) {
  return [
    route('/search', {
      GET: async ({ url, res }) => {
        const root = await rootOf(url.searchParams.get('root') ?? '')
        const maxText = url.searchParams.get('max')
        const ac = new AbortController()
        res?.on?.('close', () => {
          if (!res.writableFinished) ac.abort()
        })
        let isGit = false
        try {
          isGit = (await gitOps.repoInfo(root.path)).inside
        } catch {}
        const found = await searchRoot(
          { path: root.path, real: root.real, isGit },
          {
            q: url.searchParams.get('q') ?? '',
            regex: flag(url, 'regex'),
            caseSensitive: flag(url, 'case'),
            word: flag(url, 'word'),
            include: url.searchParams.get('include') ?? '',
            exclude: url.searchParams.get('exclude') ?? '',
            max: maxText === null || maxText === '' ? undefined : Number(maxText),
          },
          { timeoutMs, signal: ac.signal },
        )
        return found
      },
    }),
    route('/raw', {
      GET: async ({ url }) => {
        const root = await rootOf(url.searchParams.get('root') ?? '')
        const rel = url.searchParams.get('path') ?? ''
        const type = RAW_TYPES[extname(rel).toLowerCase()]
        if (type === undefined) throw new EditorError(415, 'unsupported', 'Only image files are served')
        const abs = await resolveInside(root.real, splitRelative(rel))
        let handle
        try {
          handle = await fs.open(abs, 'r')
        } catch (error) {
          throw fromFsError(error)
        }
        try {
          const stat = await handle.stat()
          if (!stat.isFile()) throw new EditorError(400, 'not-file', 'Not a regular file')
          if (stat.size > MAX_RAW_BYTES) throw new EditorError(413, 'too-large', 'Image too large')
          const body = await handle.readFile()
          return {
            [RAW]: {
              status: 200,
              headers: {
                'content-type': type,
                'content-length': String(body.length),
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                'content-disposition': 'inline',
                'referrer-policy': 'no-referrer',
              },
              body,
            },
          }
        } catch (error) {
          throw error instanceof EditorError ? error : fromFsError(error)
        } finally {
          await handle.close().catch(() => {})
        }
      },
    }),
  ]
}
