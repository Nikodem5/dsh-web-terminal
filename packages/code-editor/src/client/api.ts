// dsh-code-editor - typed wrapper over the host routes in API.md. Nothing else talks to the host.

import type { FileData, GitDiff, GitStatus, RootInfo, TreeEntry } from './types.ts'

export const API_BASE = '/api/dsh-code-editor'

/** A non-ok host answer (or a transport failure: status 0). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly data: Record<string, unknown>
  constructor(message: string, status: number, code?: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.data = data
  }
  /** 409 `conflict`: the file changed on disk; `mtime` is the current disk mtime when the host sent it. */
  get diskMtime(): number | null { return typeof this.data.mtime === 'number' ? this.data.mtime : null }
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>
}>

export interface Api {
  roots(roots: string[]): Promise<{ roots: RootInfo[]; rejected: Array<{ path: string; reason: string }> }>
  tree(root: string, dir: string): Promise<TreeEntry[]>
  files(root: string): Promise<{ files: string[]; truncated: boolean }>
  readFile(root: string, path: string): Promise<FileData>
  writeFile(root: string, path: string, content: string, expectedMtime: number | null): Promise<{ mtime: number; size: number }>
  gitStatus(root: string): Promise<GitStatus>
  gitDiff(root: string, path: string, staged: boolean): Promise<GitDiff>
  stage(root: string, paths: string[]): Promise<void>
  unstage(root: string, paths: string[]): Promise<void>
  discard(root: string, paths: string[], untracked: string[]): Promise<void>
  /** PROPOSED (API.md): resolve the root (git top-level) for an absolute path. */
  resolve(path: string): Promise<{ root: string; isGit: boolean } | null>
  /** `ws://` / `wss://` URL of the live-update socket. */
  wsUrl(root: string): string
}

const q = (params: Record<string, string>): string => new URLSearchParams(params).toString()

/** Origin of the host (the harness exposes the real loopback origin for streams; relative otherwise). */
function hostBase(): string {
  const t = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
  return t?.streamBaseUrl ?? (typeof window !== 'undefined' ? window.location.href : 'http://localhost/')
}

export function createApi(fetchImpl?: FetchLike): Api {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init))
  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    let res
    try {
      res = await doFetch(`${API_BASE}${path}`, {
        method: init?.method ?? 'GET',
        headers: init?.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : String(e), 0, 'network')
    }
    let data: Record<string, unknown>
    try { data = (await res.json()) as Record<string, unknown> } catch { data = {} }
    if (!res.ok || data.ok === false) {
      throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, typeof data.code === 'string' ? data.code : undefined, data)
    }
    return data as T
  }
  const post = <T>(path: string, body: unknown): Promise<T> => call<T>(path, { method: 'POST', body })
  return {
    roots: async (roots) => {
      const r = await post<{ roots: RootInfo[]; rejected?: Array<{ path: string; reason: string }> }>('/roots', { roots })
      return { roots: r.roots ?? [], rejected: Array.isArray(r.rejected) ? r.rejected : [] }
    },
    tree: async (root, dir) => (await call<{ entries: TreeEntry[] }>(`/tree?${q({ root, dir })}`)).entries,
    files: async (root) => {
      const r = await call<{ files: string[]; truncated: boolean }>(`/files?${q({ root })}`)
      return { files: r.files ?? [], truncated: r.truncated === true }
    },
    readFile: (root, path) => call<FileData>(`/file?${q({ root, path })}`),
    writeFile: (root, path, content, expectedMtime) => call(`/file`, { method: 'PUT', body: { root, path, content, expectedMtime } }),
    gitStatus: (root) => call<GitStatus>(`/git/status?${q({ root })}`),
    gitDiff: (root, path, staged) => call<GitDiff>(`/git/diff?${q({ root, path, staged: staged ? '1' : '0' })}`),
    stage: async (root, paths) => { await post('/git/stage', { root, paths }) },
    unstage: async (root, paths) => { await post('/git/unstage', { root, paths }) },
    discard: async (root, paths, untracked) => { await post('/git/discard', { root, paths, untracked }) },
    resolve: async (path) => {
      try { return await call<{ root: string; isGit: boolean }>(`/resolve?${q({ path })}`) } catch { return null }
    },
    wsUrl: (root) => {
      const u = new URL('/code-editor/ws', hostBase())
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
      u.searchParams.set('root', root)
      return u.toString()
    },
  }
}
