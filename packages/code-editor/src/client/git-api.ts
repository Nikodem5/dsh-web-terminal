// dsh-code-editor - typed wrapper over the git tool routes (commit, branches, history, sync). See API.md "Git tools".

export interface LocalBranch { name: string; hash: string; upstream: string | null; upstreamRemote: string | null; current: boolean }
export interface RemoteBranch { name: string; remote: string; short: string; hash: string; local: boolean }
export interface BranchInfo {
  current: string | null
  detached: boolean
  head: string | null
  upstream: string | null
  upstreamRemote: string | null
  ahead: number | null
  behind: number | null
  local: LocalBranch[]
  remote: RemoteBranch[]
  remotes: string[]
}
export interface LastCommit { hash: string | null; message: string; hasUpstream: boolean; pushed: boolean }
export interface CommitSummary { hash: string; short: string; author: string; email: string; date: number; subject: string; refs: string[] }
export interface CommitFile { status: string; path: string; origPath?: string }
export interface CommitDetail { hash: string; author: string; email: string; date: number; message: string; parent: string | null; files: CommitFile[]; truncated: boolean }
export interface CommitShow { original: string | null; modified: string | null; binary: boolean; tooLarge: boolean }

export type Call = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>

export interface GitToolsApi {
  gitCommit(root: string, opts: { message: string; amend: boolean; all: boolean }): Promise<{ hash: string; summary: string }>
  gitLastCommit(root: string): Promise<LastCommit>
  gitBranches(root: string): Promise<BranchInfo>
  gitCheckout(root: string, branch: string, create: boolean): Promise<{ branch: string }>
  gitLog(root: string, opts: { skip: number; limit: number; path?: string }): Promise<{ commits: CommitSummary[]; hasMore: boolean }>
  gitCommitInfo(root: string, hash: string): Promise<CommitDetail>
  gitShow(root: string, hash: string, path: string, origPath?: string): Promise<CommitShow>
  gitFetch(root: string): Promise<{ summary: string }>
  gitPull(root: string): Promise<{ summary: string }>
  gitPush(root: string, remote?: string): Promise<{ summary: string; setUpstream: boolean; remote: string | null; branch: string }>
}

const q = (params: Record<string, string>): string => new URLSearchParams(params).toString()

export function gitToolsApi(call: Call): GitToolsApi {
  const post = <T>(path: string, body: unknown): Promise<T> => call<T>(path, { method: 'POST', body })
  return {
    gitCommit: (root, o) => post('/git/commit', { root, message: o.message, amend: o.amend, all: o.all }),
    gitLastCommit: (root) => call(`/git/last-commit?${q({ root })}`),
    gitBranches: (root) => call(`/git/branches?${q({ root })}`),
    gitCheckout: (root, branch, create) => post('/git/checkout', { root, branch, create }),
    gitLog: async (root, o) => {
      const r = await call<{ commits?: CommitSummary[]; hasMore?: boolean }>(`/git/log?${q({ root, skip: String(o.skip), limit: String(o.limit), ...(o.path ? { path: o.path } : {}) })}`)
      return { commits: Array.isArray(r.commits) ? r.commits : [], hasMore: r.hasMore === true }
    },
    gitCommitInfo: (root, hash) => call(`/git/commit?${q({ root, hash })}`),
    gitShow: (root, hash, path, origPath) => call(`/git/show?${q({ root, hash, path, ...(origPath ? { origPath } : {}) })}`),
    gitFetch: (root) => post('/git/fetch', { root }),
    gitPull: (root) => post('/git/pull', { root }),
    gitPush: (root, remote) => post('/git/push', remote ? { root, remote } : { root }),
  }
}
