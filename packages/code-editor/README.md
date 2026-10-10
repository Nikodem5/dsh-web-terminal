# dsh-code-editor

A Monaco-based code editor and reviewer for the DeepSeek Harness web GUI. Two halves:

- **Host** (`lib/index.js`, this section): confined file and git routes plus a live-update WebSocket.
- **Client** (`lib/client.js`, built from `src/` by `build.mjs`): the "Code" page.

The host/client contract is [API.md](API.md). It is the source of truth for routes, bodies, error codes and frames.

## Host

Cordis plugin `code-editor`, `inject = ['webServer']` only (git runs through `child_process.execFile`; a real cordis ctx throws on any property that is not injected).

Routes under `/api/dsh-code-editor` (details in API.md): `roots`, `tree`, `files`, `file` (GET, PUT), `git/status`, `git/diff`, `git/stage`, `git/unstage`, `git/discard`. WebSocket: `/code-editor/ws?root=<abs>`.

### Security model

This plugin serves arbitrary file reads and writes to the browser, so every request is treated as hostile.

- **Roots are opt-in.** Only folders registered through `POST /roots` (persisted in `<dsh home>/code-editor/roots.json`, re-validated on load) can be touched. Filesystem roots, the home folder itself and its parents are refused. Unregistered root -> 403 `root`.
- **Paths are relative and confined.** Forward slashes only, no `..`, no absolute or drive paths, no NUL or control characters, length caps. The deepest existing ancestor is `realpath`ed and must stay inside the root's real path, so symlinks and junctions pointing outside are refused (403 `escape`). Percent-encoding is never decoded.
- **`.git` is off limits** to the file routes (also `.GIT`, `git~1`): editing hooks or config through the editor would be code execution. Git data is only reachable through the git routes.
- **Git is never a shell.** `execFile('git', [...])`, `--` before every path, `--literal-pathspecs` (a file called `*.txt` is just a file), `--no-optional-locks`, `core.fsmonitor=false` (an untrusted repo cannot run a command through `git status`), 20 s timeout, bounded output, at most 6 concurrent git processes.
- **Destructive git actions are narrow.** Discard deletes an untracked path only if git currently lists it as an untracked file; directories are never deleted. Git paths are confined like file paths.
- **Writes are atomic and optimistic.** Temp file in the same folder, fsync, rename; creation uses a hard link so it cannot overwrite a concurrently created file. A stale `expectedMtime` gives 409 and changes nothing.
- **Browser-facing hardening.** The terminal's Origin policy applies to every HTTP route and to the WebSocket upgrade (a foreign web page cannot read or write files through the user's browser). Bodies must be `application/json`, which also forces a CORS preflight. Extra origins: `DSH_CE_ALLOWED_ORIGINS` (also honours `DSH_WT_ALLOWED_ORIGINS`).
- Remaining limit: a path check and the following file operation are not one atomic step, so a process that can swap a directory for a link inside a registered root at exactly the wrong moment is not defended against. Anyone with that ability already controls the folder.

### Limits

| What | Limit |
|---|---|
| File read | 2 MiB (larger -> `tooLarge`); binary = NUL in the first 8 KiB or invalid UTF-8 |
| File write body | 4 MiB |
| JSON bodies | 256 KiB |
| Path | 1024 chars, 255 per segment, 1000 paths per git call |
| Registered roots | 256 |
| Tree listing | 20 000 entries per folder |
| Quick open (`/files`) | 50 000 files |
| Git status | 10 000 files, 64 MiB output |
| Sockets | 64 |

### Live updates

One watcher per root, shared by all its sockets, closed 30 s after the last socket leaves and on dispose. Changes are debounced 150 ms; more than 500 paths in one frame become `overflow`. `.git/` changes are ignored except `.git/index` and `.git/HEAD` (-> `git` frame); `node_modules/**` is ignored.

- **Windows / macOS**: one recursive `fs.watch` on the root.
- **Linux**: non-recursive watches on the root, on `.git`, and on every folder the client has listed through `/tree`, plus a 2 s poll of `git status` that raises a `git` frame. Limit: edits in a folder the client never expanded are only noticed as a `git` frame (and only in git roots).

### Tests

`npm test` (in this package, or from the repo root) runs `node --test` over `tests/`: confinement, roots, every route against temp dirs and a temp git repo, watcher frames in both modes, WebSocket origin policy, and a strict-ctx resilience test. The tests do not need `lib/client.js`.
