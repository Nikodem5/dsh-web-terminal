# dsh-web-terminal

A **Terminals** screen for DeepSeek Harness: a third tab beside *Chat* and *Trajectory* holding a
free-form workspace of real PTY terminals — open as many as you like, drag and resize them like app
windows, snap them to edges/halves/quarters, pin them in place, and watch what every agent is doing from a
list on the right. Built for running several agents (e.g. Claude Code) side by side.

## Using it

Open a session and click the **Terminals** tab.

### Opening terminals
| Action | How |
|---|---|
| New terminal | **＋ New terminal** opens a dialog: **folder** (type, **Browse…** for the native chooser, favourites ★, recents, or *Use this session's workspace*), **shell** (PowerShell / cmd / Git Bash / WSL), optional **name**, optional **startup command** typed once into the fresh shell |
| Run Claude | **✦ Claude** is the same dialog preset to `claude` (chips for `claude --resume` / `--continue`) |
| Duplicate | `⋯` menu in the window, or ⧉ in the list: same shell, folder and startup command |
| Saved layouts | **▾ Layouts**: *Save current* (windows, names, folders, shells, startup commands, positions, pins), then *Open* (replaces the open terminals) or *Add* |

### Windows
| Action | How |
|---|---|
| Move | Drag the title bar. Edges snap to the canvas and to other windows |
| Snap (Windows-style) | Drag to the top edge = maximize, left/right edge = half, a corner = quarter, bottom edge = bottom half. A ghost previews the target |
| Resize | Drag any edge or corner |
| Maximize / minimize | `□` / double-click the title bar; `–` turns a window into a chip in the toolbar |
| Pin | `◇` / `◆` locks position and size (also skipped by layout presets) |
| Layout presets | Grid, Columns, Rows, Main + side, Cascade (unpinned windows only) |
| Switch terminals | **Ctrl+Alt+←/→** cycles through the list order (works while a terminal has focus) |
| Copy / paste | `Ctrl+C` copies when text is selected (otherwise it is SIGINT); `Ctrl+Shift+C/V` always copy/paste |
| Find in terminal | **Ctrl+F** (or `⋯` → Find…) opens a find bar over the focused terminal: highlights every match in the scrollback, `n / total` counter, **Enter** / **Shift+Enter** next/previous, match-case / whole-word / regex toggles, **Esc** closes. Pre-fills from a one-line selection |
| Links | URLs in terminal output are underlined on hover; **Ctrl+click** (Cmd+click) opens them in your system browser (plain clicks still select text) |

### Knowing what your agents are doing
Status comes from the agent itself, not from guessing at output.

- **Claude Code reports its own state.** A terminal started with **✦ Claude** (or any startup command beginning
  with `claude`) is launched as `claude --settings <file>`. The file adds HTTP hooks that tell the plugin when
  Claude starts a turn, is **blocked on a permission or question**, **finishes**, or **fails**. `--settings` only
  adds to your own Claude configuration; nothing in `~/.claude` is edited. A `claude` you type by hand in a plain
  shell is not covered.
- **Status dot** on every window, chip and list row: **Working** (the agent is on a turn), **Needs you** (blocked or
  failed), **Finished** (waiting for your next prompt), **Running** (a program is running in a plain shell),
  **Idle**, **Exited**, **Offline**. A plain shell shows only facts (running or not), never a guess.
- **Two levels of attention**, raised only while you are looking elsewhere (another window, tab or terminal):
  - *Needs you* (permission, question, failure, the agent died mid-task, the shell exited mid-task or with an error,
    or a working agent that has been silent for 10 minutes): red-orange border, `needs you` badge, desktop
    notification and a chime.
  - *Finished* (a turn ended) and the terminal bell: amber border and badge; a desktop notification only when the
    whole app is in the background.
  - Answering clears it: typing into the terminal, the agent's next turn, or focusing the terminal.
- **Aa** → Notifications: desktop notifications, the chime, and the "stuck after N minutes" threshold (0 = never).
- **Broadcast**: **⇉ Broadcast** adds checkboxes to the list. Type a command in the bar and Enter sends it to
  every checked terminal; **Live mirror typing** also copies keystrokes typed in one checked terminal into the
  others.

### The terminal list (right)
Every terminal with status, name, folder and a pin marker. Click to focus, **double-click the name to rename**,
drag rows to reorder (that is also the Ctrl+Alt+←/→ order), ⧉ duplicate, ✕ close. `☰` in the toolbar hides it.

**Names**: by default a terminal is named after the program's own title — for Claude Code that is the session
title (`Fix login bug`; bare "Claude Code" becomes `Claude · <folder>`). Renaming pins your name; renaming to an
empty string returns to the automatic name.

### Safety
- Closing a terminal that is still **working or waiting** (single close, **Close all**, replacing a layout)
  asks first. Restarting a busy shell asks too.
- `⋯` → **Save log…** downloads the terminal's scrollback as a text file.

### Look
VS Code Dark+/Light+ colours following the app theme, rounded windows with an accent-ringed focus state, thin
scrollbars. **Aa** sets the **font** (presets or any installed font list; default
`'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace` at 12 px), size and line height, for all
terminals. **Shrink font to fit window** (on by default, in **Aa**): in narrow windows the font shrinks just enough
to keep about 100 columns visible (adjustable; never below 9 px, never above your size), so tiled terminals stay
readable without wrapping. Text colours in the dialogs and bars are chosen from the *measured* background, so they stay legible
whatever the theme's tokens say. New terminals open first in the list and on top of the stack.

Switching tabs or sessions does **not** touch the terminals. Window layout, names, folders, favourites and
preferences are saved in `localStorage`. **Shells also outlive a page reload**: the host keeps each PTY (and
400 KB of scrollback) and the reloaded page reattaches. Only close, the process exiting, or restarting the
harness ends a shell.

## Install

```powershell
cd <this folder>
npm run build                # bundles src/ -> lib/client.js
node install.mjs desktop     # copies into ~/.dsh/profiles/desktop
npm test                     # host (real PTY), client registration, jsdom render test
```

Restart the desktop app: plugins load at boot. `node install.mjs --remove desktop` uninstalls.

> **Why a copy and not `dsh plugin add <path>`?** `dsh plugin add` records a `link:` dependency whose real path
> lives outside the profile tree; the client-modules registry skips such packages, so the host half mounts but
> the browser half never loads. Copying keeps the package inside the profile.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | Host half: `/terminal/ws`, `/api/dsh-web-terminal/info`, persistent PTY sessions, process-tree activity polling |
| `lib/agent-signals.js` | Provider-neutral agent signals: Claude hook adapter, the generated `--settings` file |
| `src/client/index.ts` | Registers the `terminals` entry into `conversation.view`; injects the session's folder |
| `src/client/terminals-view.tsx` | The view: toolbar, window chrome, drag/resize/snap, broadcast bar |
| `src/client/sidebar.tsx` | Right-hand terminal list |
| `src/client/new-dialog.tsx` | New-terminal dialog |
| `src/client/menus.tsx` | Layouts and settings popovers |
| `src/client/actions.ts` | Safe-close prompts, native folder picker |
| `src/client/terminal-store.ts` | Barrel re-exporting the modules below |
| `src/client/state.ts`, `types.ts` | Window store, preferences, live runtime map, persistence; shared types |
| `src/client/windows.ts` | Open, close, focus, maximize, layout presets |
| `src/client/runtime.ts` | xterm + WebSocket behind each window: connect, reconnect, sizing, restart, log export |
| `src/client/attention.ts` | Status from agent signals, attention levels, notifications, chime, stuck detection |
| `src/client/launch.ts` | Adds `--settings` to a `claude` startup command |
| `src/client/search.ts`, `layouts.ts`, `broadcast.ts`, `preferences.ts`, `appearance.ts`, `names.ts`, `theme.ts` | Find, saved layouts, broadcast, folders and switches, font/colour prefs, window names, palette |
| `src/client/styles.ts`, `xterm.css.ts` | Stylesheets |
| `smoke-host.mjs` / `smoke-client.mjs` / `smoke-view.mjs` | Tests |

## Wire contract

`/terminal/ws?id=<session>&shell=<id>&cwd=<dir>&cols=<n>&rows=<n>` — `id` is required; if a session with that id
exists the socket reattaches to it, otherwise a shell is spawned.

Browser → host: `{"type":"input","data"}`, `{"type":"resize","cols","rows"}`, `{"type":"signal","signal"}`,
`{"type":"kill"}` (end the shell), `{"type":"close"}` (detach only).

Host → browser: `{"type":"attached","created","replay","exited","exitCode","agent"}` (always first; `created` is true only
for a brand-new shell, which is when the startup command runs; `agent` is the last agent signal or `null`),
`{"type":"data","data"}`, `{"type":"activity","busy"}` (a program runs under the shell),
`{"type":"agent","provider","state","detail","at"}` (an agent signal; `state` is one of `idle`, `working`,
`needs-you`, `finished`, `failed`, `ended`), `{"type":"exit","exitCode"}`, `{"type":"error","message"}`.

### Agent signals

Each shell gets a random secret in `DSH_WT_TOKEN`. The host runs a small HTTP server on `127.0.0.1` (random port)
and writes `~/.dsh/web-terminal/claude-settings-<pid>.json` (`/api/dsh-web-terminal/info` reports the path as
`agent.claudeSettings`). That file subscribes Claude Code HTTP hooks to `POST /signal/claude` and sends the secret in
the `x-dsh-wt-token` header (interpolated from the environment). The body is Claude's hook JSON; a small adapter
(`lib/agent-signals.js`) maps events to a state. Any other tool can report by POSTing
`{"state":"needs-you","detail":"..."}` to `/signal/<provider>` with the same header. Requests with an unknown secret
get 401; bodies over 64 KB get 413.

### Usage and the stats endpoint

The same settings file also sets Claude's `statusLine` to `node lib/statusline.js <host>/signal/usage` (a few
times a second while a prompt runs, otherwise every `refreshInterval` seconds, 10 unless your own status line sets
one). The wrapper POSTs Claude's status JSON to `/signal/usage` (same secret header, same limits) and runs *your*
`statusLine` command from `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) with the same stdin, printing its
output, so your status line looks the same. It needs `node` on PATH; without it the entry is left out and your own
status line keeps working (`/stats` then reports `statusLine.enabled: false`).

`GET /api/dsh-web-terminal/stats` returns

```
{ ok, limits: { fiveHour, sevenDay: { usedPct, resetsAt /*ms*/, outAt /*ms forecast or null*/ } | null, sampledAt },
  cost: { totalUsd, terminals }, tokens: { total, input, output, cacheRead, cacheCreation, asOf } | null,
  statusLine: { enabled, reason } }
```

- `limits` are account-wide, from the newest status-line sample. `outAt` is when usage reaches 100% at the recent
  pace (last hour for 5h, last 24 h for 7d; the average since the window or the first sample when there is too
  little history), `null` when the limit lasts until the reset or there is no pace.
- `cost` sums the latest `total_cost_usd` of each live terminal that reported one.
- `tokens` is the lifetime total from `~/.claude/stats-cache.json` plus transcript usage in `~/.claude/projects`
  (sub-agents included) after the cache's last computed local day, de-duplicated by message id. Rescanned at most
  once a minute in the background; `null` until the first scan finishes.
- Limits and tokens are saved to `~/.dsh/web-terminal/usage.json` so they survive a restart.

## Notes and limits

- **Desktop WebSocket address**: the page is served from `dsh-app://app`, so the client connects to
  `__DSH_TRANSPORT__.streamBaseUrl` (the loopback host origin); the app adds the auth cookie.
- **Agent state** is reported, not inferred (see *Agent signals*). The only inferred fact is "does the shell have a
  live child process" (one OS process-table query every 3 s while any terminal is attached), shown as Running and
  used to notice an agent that died without saying so. If your Claude settings restrict hooks with
  `allowedHttpHookUrls`, add `http://127.0.0.1:*/signal/claude`.
- **Resize** needs the 0.2.x subprocess provider (the desktop app's); older hosts skip it.
- **Security**: the PTY runs as you, unsandboxed, with the harness's full environment (credentials included) —
  that is what a terminal is. It is human-driven only and not exposed to model tool calls. The route is
  reachable wherever the harness web server is (loopback by default).
- Up to 24 concurrent shells. A second connection to the same id (e.g. another browser tab) supersedes the first.
- The Trajectory tab is hidden unless developer tools are enabled; the Terminals tab is not gated.
- The conversation's chat input (and its queue/todo docks) is hidden while the Terminals tab is showing, so the terminals use the full height; it returns on Chat and Trajectory. This is a CSS rule that matches the shell's composer by class substring (`composerSeat`), so a future app build that renames it would need the rule updated in `src/client/styles.ts`.
- Not yet: clickable file paths, font zoom (Ctrl+wheel), per-terminal colour tags, quick-send snippets.

## Roadmap (planned ideas, not built yet)

Ordered roughly by how much they help when running several agents. Recommended first picks are marked ★.

### Agent awareness
- ★ **Pattern alerts** — notify when a terminal prints something you choose (`error`, `Do you want to proceed?` for an agent waiting on a permission prompt, a test-failure line).
- **Idle-too-long alert** — flag a "working" terminal that has produced no output for N minutes (hung agent).
- **Resume a Claude session** — a picker in the New terminal dialog listing recent Claude sessions for the folder, opening one with `claude --resume <id>`.
- **Git status in the header** — branch name and dirty marker per terminal.
- **Worktree launcher** — one click to create a git worktree and open an agent terminal in it, so parallel agents don't clash.

### Speed and navigation
- ★ **Shortcuts** — `Ctrl+Alt+N` new terminal, `Ctrl+Alt+W` close, `Ctrl+Alt+1–9` jump to a terminal.
- ★ **Focus mode** — one key maximizes the current terminal and the same key restores the layout.
- **Smarter placement** — new terminals fill the largest free gap instead of cascading over others.
- **Search all terminals** — one search box across every terminal's scrollback, jumping to the match.

### Files and input
- ★ **Clickable file paths** — `Ctrl+click` on `src/foo.ts:42` opens it (URLs already work).
- **Drag a file or folder onto a terminal** — pastes its quoted path.
- **Quick-send snippets** — saved prompts sent to one terminal or to the broadcast group.

### Terminal polish
- **`Ctrl+wheel` font zoom**, copy on select, scrollback size and cursor style settings.
- **Colour tag per terminal** — a coloured strip on the title bar and list row.
- **Shell profiles** — named presets with shell, folder, environment variables and startup command (a WSL distro, an SSH host).

### Housekeeping
- **Per-workspace layouts** — open a saved layout automatically for a given DSH workspace.
- **Import / export layouts** as a file, to move between machines.
- **CI** — GitHub Actions running `npm test` (host, client registration, jsdom render) on every push.

### Larger, with a caveat
- **Let the DSH chat agent read a terminal's output.** Blocked on purpose today: it would hand a model unsandboxed shells and their credentials. If built, it should be opt-in per terminal and read-only.
