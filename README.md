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
- **Status dot** on every window, chip and list row: **Working** (output streaming, or Claude's spinner title),
  **Waiting** (a program is running under the shell but quiet — typically an agent waiting for you),
  **Idle** (at the shell prompt), **Exited**, **Offline**.
- **Attention badge + desktop notification**: when a terminal that worked for 3 s+ goes quiet, exits, or rings the
  bell while you are looking elsewhere (another window, another tab, another terminal), its border turns amber,
  the list row gets a `!`, the toolbar shows "N need you", and — if the app is in the background or the
  Terminals tab is hidden — a notification fires (click it to jump to the terminal). Toggle in **Aa**.
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
| `src/client/index.ts` | Registers the `terminals` entry into `conversation.view`; injects the session's folder |
| `src/client/terminals-view.tsx` | The view: toolbar, window chrome, drag/resize/snap, broadcast bar |
| `src/client/sidebar.tsx` | Right-hand terminal list |
| `src/client/new-dialog.tsx` | New-terminal dialog |
| `src/client/menus.tsx` | Layouts and settings popovers |
| `src/client/actions.ts` | Safe-close prompts, native folder picker |
| `src/client/terminal-store.ts` | Window state, runtimes (xterm + socket), activity/attention, preferences |
| `src/client/styles.ts`, `xterm.css.ts` | Stylesheets |
| `smoke-host.mjs` / `smoke-client.mjs` / `smoke-view.mjs` | Tests |

## Wire contract

`/terminal/ws?id=<session>&shell=<id>&cwd=<dir>&cols=<n>&rows=<n>` — `id` is required; if a session with that id
exists the socket reattaches to it, otherwise a shell is spawned.

Browser → host: `{"type":"input","data"}`, `{"type":"resize","cols","rows"}`, `{"type":"signal","signal"}`,
`{"type":"kill"}` (end the shell), `{"type":"close"}` (detach only).

Host → browser: `{"type":"attached","created","replay","exited","exitCode"}` (always first; `created` is true only
for a brand-new shell, which is when the startup command runs), `{"type":"data","data"}`,
`{"type":"activity","busy"}`, `{"type":"exit","exitCode"}`, `{"type":"error","message"}`.

## Notes and limits

- **Desktop WebSocket address**: the page is served from `dsh-app://app`, so the client connects to
  `__DSH_TRANSPORT__.streamBaseUrl` (the loopback host origin); the app adds the auth cookie.
- **Activity** is a heuristic: output recency, Claude's title glyphs, and "does the shell have a live child
  process" (one OS process-table query every 3 s while any terminal is attached). "Waiting" cannot distinguish an
  agent awaiting input from a silent long-running command.
- **Resize** needs the 0.2.x subprocess provider (the desktop app's); older hosts skip it.
- **Security**: the PTY runs as you, unsandboxed, with the harness's full environment (credentials included) —
  that is what a terminal is. It is human-driven only and not exposed to model tool calls. The route is
  reachable wherever the harness web server is (loopback by default).
- Up to 24 concurrent shells. A second connection to the same id (e.g. another browser tab) supersedes the first.
- The Trajectory tab is hidden unless developer tools are enabled; the Terminals tab is not gated.
- The conversation's chat input (and its queue/todo docks) is hidden while the Terminals tab is showing, so the terminals use the full height; it returns on Chat and Trajectory. This is a CSS rule that matches the shell's composer by class substring (`composerSeat`), so a future app build that renames it would need the rule updated in `src/client/styles.ts`.
- Not yet: clickable file paths, font zoom (Ctrl+wheel), per-terminal colour tags, quick-send snippets.
