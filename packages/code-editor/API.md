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

## Host implementation notes (what the host actually does; additions to the contract above)
- **Requests**: every route checks the `Origin` header with the terminal's policy (no Origin, the harness' own loopback origin and `dsh-app://` pass; extra origins via `DSH_CE_ALLOWED_ORIGINS`, also `DSH_WT_ALLOWED_ORIGINS`) -> 403 `code: 'origin'`. POST/PUT bodies must be `Content-Type: application/json` (else 415). Wrong HTTP method -> 405. A missing `root` -> 400 `bad-request`.
- **Roots**: `POST /roots` returns the whole registered union (not only the posted entries) plus `rejected: [{ path, reason }]` for refused entries. Also refused: parents of the home folder (`C:\Users`, `/home`), relative paths, files. Max 256 roots; persisted ones are re-validated on load; a vanished persisted root stays listed with `exists: false`.
- **Paths**: forward slashes only (a backslash is 400 `bad-path`), max 1024 chars / 255 per segment; control characters and NUL -> 400 `bad-path`. `..`, absolute paths, drive letters (and on Windows `:<>"|?*`) -> 403 `escape`. Any `.git` segment (any case, `git~1`) is refused with 403 `forbidden` on every file and git route (no hook injection through the editor); git data is reachable only through the git routes. Percent-encoding is never decoded by the host.
- **Files**: `GET /file` on a non-regular file -> 400 `not-file`; a file that is not valid UTF-8 is reported `binary: true`. `mtime` is `stat.mtimeMs` (a float): send it back unchanged. `PUT` of an existing path with `expectedMtime: null`, or of a missing path with a number -> 409 `conflict` (`mtime` is the current value, or `null`). Missing parent folders are created (inside the root). Atomic writes use `.name.<random>.dsh-tmp` temp files, which the watcher never reports. Content over 4 MiB -> 413 `too-large`. `/tree` hides only `.git`; the non-git `/files` walk skips `node_modules .git dist build`.
- **Git**: status `index` / `worktree` are single characters: `M A D R C T U`, a space for "no change", `?` and `?` for untracked; conflicted entries have `conflicted: true`, `staged: false`, `unstaged: false`. Untracked files are listed one by one (`--untracked-files=all`); `status` also returns `truncated` (cap 10 000 files). A root that is a sub-folder of a work tree works: paths are root-relative and entries outside the root are dropped. `unstage` in a repo without commits uses `git rm --cached` (there is no HEAD to restore from). `discard.untracked` entries must currently be listed as untracked by git (else 409 `not-untracked`, nothing is changed) and must be files (400 `not-file`). Git failures -> 500 `code: 'git'` with git's first stderr line; timeout -> 504 `timeout`; missing git -> 501 `no-git`. git runs with `--literal-pathspecs`, `--no-optional-locks` (status never rewrites `.git/index`, so it cannot feed the watcher) and `core.fsmonitor=false`.
- **WebSocket**: an upgrade for an unregistered root is refused with 403 before the handshake (400 when `root` is missing). Frames from the client are ignored. `node_modules/**` changes are not reported.
- **Build**: `npm run build` first runs `scripts/copy-shared-host.mjs` (copies `packages/shared/host` to `lib/shared/`, which the host imports), then `node build.mjs`; build.mjs does not need to copy anything.
