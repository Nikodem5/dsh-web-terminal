# dsh-code-editor

A Monaco-based code editor and reviewer for the DeepSeek Harness web GUI. Two halves:

- **Host** (`lib/index.js`, this section): confined file and git routes plus a live-update WebSocket.
- **Client** (`lib/client.js`, built from `src/` by `build.mjs`): the "Code" page.

The host/client contract is [API.md](API.md). It is the source of truth for routes, bodies, error codes and frames.

## Host

Cordis plugin `code-editor`, `inject = ['webServer']` only (git runs through `child_process.execFile`; a real cordis ctx throws on any property that is not injected).

Routes under `/api/dsh-code-editor` (details in API.md): `roots`, `tree`, `files`, `file` (GET, PUT), `git/status`, `git/diff`, `git/stage`, `git/unstage`, `git/discard`, plus the git tools `git/commit` (GET and POST), `git/last-commit`, `git/branches`, `git/checkout`, `git/log`, `git/show`, `git/fetch`, `git/pull`, `git/push` (`lib/git-tools.js`). WebSocket: `/code-editor/ws?root=<abs>`.

### Security model

This plugin serves arbitrary file reads and writes to the browser, so every request is treated as hostile.

- **Roots are opt-in.** Only folders registered through `POST /roots` (persisted in `<dsh home>/code-editor/roots.json`, re-validated on load) can be touched. Filesystem roots, the home folder itself and its parents are refused. Unregistered root -> 403 `root`.
- **Paths are relative and confined.** Forward slashes only, no `..`, no absolute or drive paths, no NUL or control characters, length caps. The deepest existing ancestor is `realpath`ed and must stay inside the root's real path, so symlinks and junctions pointing outside are refused (403 `escape`). Percent-encoding is never decoded.
- **`.git` is off limits** to the file routes (also `.GIT`, `git~1`): editing hooks or config through the editor would be code execution. Git data is only reachable through the git routes.
- **Git is never a shell.** `execFile('git', [...])`, `--` before every path, `--literal-pathspecs` (a file called `*.txt` is just a file), `--no-optional-locks`, `core.fsmonitor=false` (an untrusted repo cannot run a command through `git status`), 20 s timeout, bounded output, at most 6 concurrent git processes.
- **Git tools are bounded.** Commit, checkout, fetch, pull and push never use a shell, never `--force`, and never wait for input: `GIT_TERMINAL_PROMPT=0`, closed stdin, no askpass / credential-manager UI, ssh in batch mode (a remote that needs credentials fails with "Authentication required - run git in a terminal"). Pull is `--ff-only --no-rebase` (no silent merge commits), push sets an upstream only for a branch that has none, checkout never stashes or forces (git's refusal is shown), and the client asks for a confirmation naming repository, branch and remote before every pull and push. Branch names are checked with `git check-ref-format --branch`, commit hashes with `^[0-9a-f]{4,40}$`, and `protocol.ext.allow=never` is always set. Sync commands time out after 120 s. One mutating git-tool call per repository at a time (409 `busy`).
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

## Client (the Code page)

Source in `src/client/`, built by `node build.mjs` into one classic script (`lib/client.js`, about 3.8 MiB: Monaco 0.52.2 lite, the editor worker and the codicon font are embedded). Monaco only runs when the Code page first opens, so a failure there shows a notice and never breaks plugin loading. Workers start from a blob URL (data: URL, then the main thread, as fallbacks). Highlighting is Monarch only (no TypeScript language service); JSON has a small built-in grammar.

### Features

- Sidebar: root picker (harness Workspaces, folders opened before), **Browse...** (the desktop app's native folder dialog, `__DSH_DIRECTORY_PICKER__`; without it a typed absolute path via "Open folder..."), a **Search files** button (same as the shortcut), EXPLORER (lazy tree with file-type icons, refreshed on live `changed` frames) and CHANGES (Staged / Changes / Untracked; per-file Stage, Unstage, Discard; group Stage all / Unstage all). Discard asks first and lists the untracked files it will delete.
- **Git tools** (per repository, in CHANGES): a **sync bar** (branch chip, `↑ahead ↓behind`, Fetch / Pull / Push with a spinner while running) and a **commit box** (multi-line message with a first-line counter against 72 characters, `Ctrl+Enter` commits). Commit takes the staged changes; with nothing staged the button becomes "Commit all tracked (N)" and asks first (`git commit -a`, untracked files excluded). **Amend last commit** prefills the previous message and warns (plus a confirm) when that commit is already on the upstream branch. Pull and Push ask for a confirmation naming repository, branch and remote; Pull is fast-forward only; a push of a branch without upstream says it will run `git push -u <remote> <branch>`. Errors (hook output, missing `user.name`/`user.email`, authentication, git refusals) are shown inline and nothing is retried. The **branch chip** (CHANGES, repository blocks, status bar) opens a picker: switch to a local branch, check out a remote branch as a tracking branch, or type a new name to create it from HEAD. A **HISTORY** section lists commits 50 at a time (short hash, subject, refs, author, relative date, "Load more"); click a commit for its changed files (A / M / D / R) and a file for a read-only diff of parent vs commit in the diff editor. The **History** button of a file tab shows that file's history (`--follow`). Every mutation refreshes CHANGES, the explorer and open files (the host also sends the `git` frame). Logic: `src/client/git-tools.ts`, UI: `src/client/git-panel.tsx`, API wrapper: `src/client/git-api.ts`.
- **Nested repositories** (like VS Code): when the open folder is inside a git work tree, CHANGES shows that repository. When it is NOT a repository but contains some (e.g. a monorepo-of-repos), CHANGES lists every repository found up to 4 levels down (`GET /git/repos`, cap 50, `node_modules` and hidden folders skipped), each collapsible with its branch, count, status groups and actions; repositories without changes start collapsed. The refresh button rescans. No repository at all: "No git repository in this folder."
- **Layout**: drag the bar between the sidebar and the editor (200-640 px, default 280) and the bar between EXPLORER and CHANGES; arrow keys on a focused bar nudge it, double-click resets. Both sections collapse. Sizes and collapsed state are remembered (`localStorage`, global). 13 px UI text, 24 px rows, 35 px tab bar, 22 px status bar.
- File-type icons (explorer, tabs, quick open, changes): small inline SVG badges chosen by extension or well-known name (`src/client/file-icons.ts`), no icon font.
- Tabs with a dirty dot, middle-click close and a confirmation for unsaved tabs. Files open in Monaco; change entries open in the diff editor (staged or unstaged, side by side or inline).
- Saving sends `expectedMtime`. A 409 (or an on-disk change under unsaved edits) shows "File changed on disk" with Reload / Overwrite / Compare (disk vs mine diff, then keep mine or take disk).
- A clean open tab reloads silently on disk changes (cursor and scroll kept). Status bar: branch, ahead/behind, live state, root, line:col, EOL, language.
- Per-root UI state (open tabs, active tab, expanded folders, diff layout) is kept in `localStorage`.

### Shortcuts

| Key | Action |
|---|---|
| Ctrl+E | Search files (quick open: fuzzy over the repo files; Up/Down, Enter, Esc). Also the "Search files" button |
| Ctrl+P | Same, where the app lets the page have it (see below) |
| Ctrl+S | Save the active file |
| Ctrl+F4 | Close the active tab (asks when dirty); also middle-click or the tab's x |
| Ctrl+F | Find (Monaco) |

**Why these keys.** The desktop app owns some accelerators and handles them before the page: Ctrl+W (it minimises the window, so closing a tab is Ctrl+F4 instead) and Ctrl+P (its own file page, `Mod+P`; so search files defaults to Ctrl+E, VS Code's alias of Quick Open). Ctrl+T, Ctrl+K and Ctrl+B are the app's too. The keys are caught on `window` in the capture phase while the Code page is mounted (so they work with the focus anywhere on the page, not only inside the page's own elements) and again as Monaco commands in the editor. Ctrl+S / Ctrl+F4 are not taken inside plain text inputs (folder path, quick-open box); the search key works everywhere.

### Opening files from other plugins

```js
window.dispatchEvent(new CustomEvent('dsh-code-editor:open', {
  detail: { path: 'C:\work\repo\src\a.ts', line: 12, col: 3, review: false, root: 'C:\work\repo' },
}))
```

`path` is absolute; `line`, `col`, `review` and `root` are optional. A file opens at `line`/`col`; with `review` its git diff opens (a clean file opens plain). A **folder** with `review: true` shows the CHANGES section of its root (expanded, git refreshed). The editor finds the registered root containing the path; otherwise it asks `GET /resolve` (git top-level, else the folder), registers that root with `POST /roots` and uses it.

On load the editor sets `window.__dshCodeEditor = { version: 1 }` so other plugins can tell it is installed (the terminal falls back to VS Code when the marker is missing).

**Switching to the Code page**: the harness `layout` service (`ctx.layout.selectPanel(id)`, provided by the app frame plugin, which the sidebar also requires) is picked up with `ctx.inject(['layout'], cb)`, so it is not a hard dependency: the plugin loads without it, and without it a request still opens the file and the user switches pages manually. The harness cordis has no `{ optional }` inject form (an object `inject` is a service-name map), and `ctx.layout` is never read directly because that throws for services not in `inject`. See `src/client/layout-link.ts`.

### Client tests

`tests/git-tools-routes.test.mjs` runs the git tools against temp repositories with a bare `file://` remote (commit, amend, hook and identity failures, branches, log paging, commit files and show, fetch / pull / push, no-prompt behaviour against an unreachable host and a server answering 401). `tests/client-git-tools.test.mjs` covers the client state (confirm gates, error display, history, read-only diffs). `tests/client-*.test.mjs` (api wrapper, fuzzy ranking, changes grouping, discard plan, explorer rows, shortcuts, persistence, live socket, store state machine) and `smoke-view.mjs` (renders the page in jsdom with a mocked fetch and a fake editor host).
