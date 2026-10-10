# dsh-code-editor: host <-> client contract (v1)

Package: `packages/code-editor`, npm name `dsh-code-editor`, cordis plugin name `code-editor`.
Host half: `lib/index.js` (plain JS, ESM). Client half: `lib/client.js` (esbuild IIFE, like the terminal).
Host `inject = ['webServer']` ONLY (plus `subprocess` if needed). NEVER read any other ctx property: a real cordis ctx throws on uninjected properties.
All routes: JSON in/out, `cache-control: no-store`. Errors: `{ ok: false, error: string, code?: string }` with a fitting HTTP status.

## Roots (confinement)
Every file/git operation names a `root` (absolute folder) and a `path` RELATIVE to it (forward slashes).
- `POST /api/dsh-code-editor/roots` body `{ roots: string[] }` -> `{ ok, roots: [{ path, exists, isGit }] }`.
  The client registers the folders it knows (harness Workspaces from `useWorkspaces`, plus folders the user picked). The host keeps the union for its lifetime (also persisted to `<dsh home>/code-editor/roots.json`). Only existing absolute directories are accepted; filesystem roots (`C:\`, `/`) and the user's home folder itself are refused.
- Any request whose `root` is not registered -> 403 `code: 'root'`.
- `path` is resolved with `realpath`; anything that escapes the root (`..`, absolute, symlink/junction pointing outside) -> 403 `code: 'escape'`.

## Files
- `GET /api/dsh-code-editor/tree?root=&dir=` (dir relative, '' = root) -> `{ ok, entries: [{ name, type: 'file'|'dir'|'symlink', size, mtime }] }`, sorted dirs first. Hidden `.git` omitted. No recursion (lazy expand).
- `GET /api/dsh-code-editor/files?root=` -> `{ ok, files: string[], truncated: boolean }` for quick open: `git ls-files --cached --others --exclude-standard` in git roots, otherwise a walk skipping `node_modules`, `.git`, `dist`, `build`; cap 50 000.
- `GET /api/dsh-code-editor/file?root=&path=` -> `{ ok, content: string|null, mtime, size, binary: boolean, tooLarge: boolean, eol: 'lf'|'crlf' }`. Limit 2 MiB; binary = NUL byte in the first 8 KiB.
- `PUT /api/dsh-code-editor/file` body `{ root, path, content, expectedMtime: number|null }` -> `{ ok, mtime, size }`. If the file exists and its mtime differs from `expectedMtime` -> 409 `code: 'conflict'` with `{ mtime }`. `expectedMtime: null` = create new (409 if it exists). Write atomically (temp file + rename in the same dir). Body limit 4 MiB.

## Git (only when the root is a git work tree; otherwise 409 `code: 'not-git'`)
All git calls: `execFile('git', [...args], { cwd: root })`, never a shell, paths after `--`, 20 s timeout. Missing git -> `code: 'no-git'`.
- `GET /api/dsh-code-editor/git/status?root=` -> `{ ok, branch, ahead, behind, files: [{ path, origPath?, index: string, worktree: string, staged: boolean, unstaged: boolean, untracked: boolean, conflicted: boolean }] }` from `git status --porcelain=v2 -z --branch`.
- `GET /api/dsh-code-editor/git/diff?root=&path=&staged=0|1` -> `{ ok, original: string|null, modified: string|null, binary, tooLarge }`. staged=0: original = index version (`git show :path`, or HEAD when not in index, null for untracked), modified = working file. staged=1: original = HEAD version (null if added), modified = index version.
- `POST /api/dsh-code-editor/git/stage` body `{ root, paths: string[] }` -> `{ ok }` (`git add -- paths`).
- `POST /api/dsh-code-editor/git/unstage` body `{ root, paths }` -> `{ ok }` (`git restore --staged -- paths`, fallback `git reset -q HEAD -- paths` for repos without HEAD).
- `POST /api/dsh-code-editor/git/discard` body `{ root, paths, untracked: string[] }` -> `{ ok }`: tracked paths `git restore --worktree -- paths`; untracked files listed in `untracked` are deleted (files only, never directories). The client must confirm with the user first.

## Live updates
- WebSocket `/code-editor/ws?root=<abs>` (same Origin policy as the terminal plugin: reuse its logic or copy `packages/terminal/lib/origin.js` into packages/shared/host). Server -> client frames:
  - `{ type: 'hello', root }`
  - `{ type: 'changed', paths: string[] }` relative paths changed on disk, debounced 150 ms, capped 500 per frame (`{ type: 'changed', paths: [], overflow: true }` = "reload everything"). Ignore `.git/` internals except `index` and `HEAD`, which produce `{ type: 'git' }` (status may have changed).
  - `{ type: 'git' }` also sent after any stage/unstage/discard/write.
- Watcher: `fs.watch(root, { recursive: true })` on Windows/macOS; on Linux fall back to watching opened directories + a 2 s poll of `git status` (document the limit). One watcher per root shared by all sockets; closed 30 s after the last socket leaves and on dispose.

## Client page
Main page key and sidebar id: `dsh-code-editor`, label "Code", order 6 (after Terminals = 5).
Cross-plugin "open" request: any plugin may `window.dispatchEvent(new CustomEvent('dsh-code-editor:open', { detail: { path: <absolute>, line?, col?, review?: boolean, root?: <absolute> } }))`. The editor resolves the root (registered root containing the path; else registers the path's git top-level / parent dir), opens the file (or the review view when `review`), and selects its own panel.
