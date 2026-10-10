# dsh-web-terminal

A **Terminals** page for DeepSeek Harness: a sidebar entry (right after *Plugins*) that opens a full page holding a
free-form workspace of real PTY terminals — open as many as you like, drag and resize them like app
windows, snap them to edges/halves/quarters, pin them in place, and watch what every agent is doing from a
list on the right. Built for running several agents (e.g. Claude Code) side by side.

## Using it

Click **Terminals** in the left sidebar. It is a page of its own, like Plugins and the Task manager, so it
works with the sidebar expanded or collapsed and no chat session is involved.

### Opening terminals
| Action | How |
|---|---|
| New terminal | **＋ New terminal** opens a dialog: **folder** (type, **Browse…** for the native chooser, favourites ★, recents, or one of the harness's **Workspaces** — shown as chips under the folder field, as listed in the left sidebar), **shell** (PowerShell / cmd / Git Bash / WSL), optional **name**, optional **startup command** typed once into the fresh shell, as soon as its prompt is up (it has printed and gone quiet for a moment; at most 5 s) |
| Run Claude | **✦ Claude** is the same dialog preset to `claude` (chips for `claude --resume` / `--continue`) |
| Connect over ssh | **⇄ SSH** (or the **⇄ SSH** tab of the dialog): a terminal on another machine, see [SSH terminals](#ssh-terminals) |
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
| Jump to new output | **Ctrl+Shift+U** scrolls to the "new since" divider (see below) |
| Help | **F1** or the book button in the toolbar opens the help panel (see below); **Esc** closes it. F1 is not sent to the program |
| Links | URLs in terminal output are underlined on hover; **Ctrl+click** (Cmd+click) opens them in your system browser (plain clicks still select text) |

### Overview (mission control)
**Overview** in the toolbar (or **Ctrl+Shift+Space**) shows every terminal, minimized ones included, as a live tile in an automatic grid. Each tile carries the name, status dot, attention badge and folder. Type to filter by name or folder, arrows move the selection, **Enter** or a click opens that terminal (restoring it if minimized), **Esc** leaves without changing focus. Terminals are only scaled with CSS, never resized, so TUIs do not redraw and the host sees no resize; your layout (rects, stacking, minimized) is untouched and never saved in overview form.

### Help panel
The book button (or **F1**) opens a panel with six sections: every keyboard shortcut (with a filter box), the mouse actions, the SSH notes, what the status dots, badges and command-bar colours mean, a legend for the stats bar, and live diagnostics (plugin version, whether `node`, `claude` and `ssh` were found and how many hosts `~/.ssh/config` lists, whether the status-line wrapper is on and why not, shell integration for the focused terminal, connection counts, age of the last limits sample). **Copy diagnostics** puts a plain-text report on the clipboard (versions, paths and states only; no tokens). The version and the `node` lookup come from `/api/dsh-web-terminal/info` (`version`, `node: { available, path }`). The panel is the source of truth for shortcuts: it and the key handlers read one registry (`src/client/shortcuts.ts`), and a test checks the real terminal handler against it.

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

### New since you last looked
A terminal counts as looked at while its window is focused, the Terminals page is showing and the app is in front. When you stop looking, the plugin remembers where the output ended. Output that adds at least one new line while you are away shows as a small count on the terminal's list row (separate from attention badges; in-place repaints such as a status line do not count). When you come back, a thin divider `── new since 14:32 ──` marks the first new line and stays until you look away again. If it is above the visible rows, a `↓ 42 new lines` pill at the window's bottom right (or **Ctrl+Shift+U**) jumps to it. Full-screen programs (vim, htop) are skipped, and a divider whose line has scrolled out of the scrollback is not shown. Attention and alerts are unchanged.

### Stats bar (chat header and Terminals page)
A compact one-line bar in the chat header, and again in the Terminals page toolbar (next to *Close all*): terminal counts by status (working, needs you,
finished; hidden at zero), the 5-hour and 7-day Claude limits (`5h 42% · resets 14:30 · out ~13:55`, where *out* is
the forecast time of hitting 100%), the summed API-price-equivalent cost and the token total (hover for the split).
Limits are read from the last Claude terminal that reported them; a sample older than 10 minutes is dimmed with its
age. The host is polled every 5 s while the page is visible; if the host does not serve `/stats` (older install),
only the terminal counts show. Counts do not need the Terminals page to be opened.
If the shell does not expose its Workspaces, the dialog instead offers *Use the last session's workspace*: the folder
of the chat session last viewed (recorded by the header bar and kept in the preferences).

### The terminal list (right)
Every terminal with status, name, folder and a pin marker. Click to focus, **double-click the name to rename**,
drag rows to reorder (that is also the Ctrl+Alt+←/→ order), ⧉ duplicate, ✕ close. `☰` in the toolbar hides it.

**Names**: by default a terminal is named after the program's own title — for Claude Code that is the session
title (`Fix login bug`; bare "Claude Code" becomes `Claude · <folder>`). Renaming pins your name; renaming to an
empty string returns to the automatic name.

### Sub-agents panel (right)
`Agents` in the toolbar (with a badge of running sub-agents) opens a panel beside the terminal list, remembered in the
preferences. Sub-agents Claude spawned are grouped by terminal (click a group header to focus its window); each row shows
status, label, type, short model name (`haiku-5-5`), elapsed time (ticking while running) and tokens. Running ones come
first; completed ones are dimmed and drop off about five minutes after they end. The stats bar adds `N agents` while any
run. The host sends `{"type":"subagents","tasks":[...]}` (the full list) on change, and `attached` carries `subagents`;
an older host without them simply shows an empty panel.

### Clickable file paths
Hold **Ctrl** (**Cmd** on macOS) over a file path in the output: it is underlined, the pointer changes and a tooltip
shows the resolved path. **Ctrl+click** opens it; plain clicks still select text and reach TUIs that read the mouse.
Only paths that **exist** are linked (checked by the host, batched, cached per terminal for 10 s, misses included).

- **Detected**: `C:\a\b.ts`, `C:/a/b.ts`, `\\server\share\f`, `/a/b.ts`, `~/a/b`, `src/a.ts`, `./a`, `../a`, and a bare
  `file.ext` (extension required). Positions: `:12`, `:12:5`, `(12)`, `(12,5)`, `#L12`, `#L12-L20`, `line 12`
  (`, line 12, column 5`). Quotes, brackets and trailing `. , ; :` are stripped; paths with spaces need quotes. URLs
  (the web-links addon owns those), versions (`1.2.3`), times (`12:30`) and ratios are ignored. Wrapped lines are joined.
- **Relative paths** resolve against the terminal's folder: on **Linux** the live cwd of the shell's newest
  descendant (else the shell) from `/proc`, so a `cd` is followed. On **Windows and macOS** only the folder the
  terminal was started in is known, so after a `cd` relative paths still resolve against the start folder (absolute
  ones are unaffected). Git Bash `/c/Users/...` paths are mapped to `C:\Users\...` on Windows.
- **Aa → Clickable file paths → Open with**: `VS Code` (default, `code -g file:line:col`), `Cursor`, `OS default app`
  (Explorer / `xdg-open` / `open`; programs and scripts such as `.exe .bat .sh` are refused, since opening would run
  them) or `Custom command`, a template like `myeditor {file}:{line}:{col}`. Placeholders `{file} {line} {col} {dir}`;
  quotes group arguments; each argument is substituted separately (a path with spaces stays one argument). A missing
  line/col written after a `:` is dropped together with the colon, anywhere else it becomes `1`. Folders always open in
  the file manager. If the editor is missing, a message appears in the terminal (e.g. "VS Code not found on PATH").
- **Routes** (behind the harness `/api` checks, POST JSON): `/api/dsh-web-terminal/paths`
  `{terminalId, cwd?, candidates[≤50, ≤1024 chars]}` → `{ok, results:[{candidate, path|null, isDir}]}` (`stat` only,
  file contents are never read; `cwd` is the fallback when the session is unknown), and `/api/dsh-web-terminal/open`
  `{path, line?, col?, target:'vscode'|'cursor'|'default'|'custom', template?}` → `{ok}` or `{ok:false, error}`. The path
  is re-checked to exist. Programs are started from an argv array, detached, without a shell; on Windows a `.cmd` shim
  is replaced by the real `Code.exe`/`Cursor.exe` beside it, and only if there is none run through `cmd.exe` after
  arguments with shell metacharacters are refused. The browser already has a full shell over `/terminal/ws`, so a
  custom command adds no capability.

### Command blocks / shell integration

A shell that cooperates tells the terminal where each prompt, command and output starts and how the command ended, so
every command becomes a **block**. Phase 1 draws a thin bar in the left padding of the terminal: pulsing accent while
the command runs, green when it succeeded, red when it failed (grey if the shell reported no exit code). The model
(command, exit code, duration, folder, xterm markers for prompt / input / output / end; up to 500 per terminal) is
kept for the next steps (hover actions, jumping between blocks, failed-command alerts). The shell also reports its
**real current folder**, which Ctrl+click on a relative path now resolves against, even on Windows where a `cd` was
invisible before. When it is active, the startup command is typed the moment the first prompt is ready instead of after
a quiet period.

- **How**: invisible OSC sequences, VS Code's convention: `133;A` prompt start, `133;B` prompt end, `133;C` output
  start, `133;D;<exit>` finished, `633;E;<command>` the command line (`\`, `\x3b` for `;` and `\xNN` for control
  characters), `633;P;Cwd=<folder>`. OSC 7 (`file://host/path`) is understood too. Nothing is printed.
- **Injected at spawn, your files stay untouched.**
  - PowerShell 5.1 / 7: `powershell.exe -NoLogo -NoExit -Command ". ([scriptblock]::Create([IO.File]::ReadAllText('<plugin>/lib/shell/integration.ps1')))"`.
    Your profile loads first; the script then wraps whatever `prompt` exists (oh-my-posh, starship, your own): D with the
    exit code, the folder and A before it, B after it. C and E come from wrapping `PSConsoleHostReadLine`, which PowerShell
    calls once per accepted line whatever key accepted it. Without PSReadLine there is no such hook, so only prompts and
    folder are reported (no blocks). The script is read as text, so a Restricted execution policy does not block it.
  - bash (Linux): `bash --rcfile <plugin>/lib/shell/integration.bash -i`. The script first sources `~/.bashrc` (bash
    itself reads `/etc/bash.bashrc` where the distro builds that in), then prepends to `PROMPT_COMMAND` (your `$?` is
    preserved), appends B to `PS1` last (so prompt tools that rewrite `PS1` keep working), and prints C from `PS0`
    (bash 4.4+) or a `DEBUG` trap on older versions. E is read from history after the command ended.
  - Git Bash: the same with `DSH_WT_BASH_LOGIN=1` in the environment instead of `-l` (a login shell ignores
    `--rcfile`): the script replays `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`. The
    shell is therefore not a "login shell" (`logout` does not work, use `exit`).
  - cmd, WSL, sh, fish: no integration. **zsh: not yet** (needs a `ZDOTDIR` shim; started as before).
- **Turn it off**: Aa menu, **Shell integration** (applies to terminals started after the change; the client adds
  `integration=0` to the socket URL), or `DSH_WT_SHELL_INTEGRATION=0` in the harness environment for every shell.
- **Limits**: a command that bash's history does not record (`HISTCONTROL=ignorespace`) has its text read from the
  screen instead. A nested shell or `ssh` session does not report (its prompt is not wrapped). A prompt function that
  returns nothing (so PowerShell would print its own `PS>`) gets B before that text.
### Send a selection to another terminal
Select text (an error in a build terminal, say), **right-click** it and pick where it goes, or press **Ctrl+Shift+S**
(arrows + Enter, Esc cancels). The menu offers **Copy**, every other connected terminal (agents first, with their
status dot) and **New Claude terminal here** (same folder and shell; the text is sent once `claude` is typed, its screen
is quiet and it has switched paste mode on, and is copied to the clipboard instead if that takes over a minute).

- The text is **pasted, never submitted**: you add context and press Enter. It goes in as a bracketed paste when the
  target enabled that mode (Claude Code does); otherwise it is typed with the last line left open, and a multi-line
  send asks first because each line would run. Trailing spaces are trimmed and control characters removed; over 32 KB
  asks first. The target window is focused and restored if minimized.
- **Aa → Send selection**: "Wrap text sent to an agent in a code block" (default on) sends a fenced block so the agent
  reads it as quoted output. Other terminals get the plain text.
- **Mouse programs**: while a TUI tracks the mouse, right-click belongs to it and passes through; **Shift+right-click**
  (xterm's usual "select instead" key) opens the menu there. Without a selection right-click is unchanged.

### SSH terminals
For the laptop-to-home-PC case: **⇄ SSH** in the toolbar (next to **✦ Claude**) opens the new-terminal dialog on its SSH tab, and the
window runs your system `ssh` client in the same PTY as any other terminal.

- **Where targets come from.** The dialog lists the concrete `Host` aliases of `~/.ssh/config` (with `user@hostname:port` as the
  subtitle; `Include` directives are followed, relative to `~/.ssh`, with `*` and `?` in the file name; wildcard hosts such as
  `Host *` are skipped). Or type `user@host` / `user@host:2222` (IPv6 in brackets). Recent targets are kept (ten at most, newest
  first; ★ keeps one). **Run on connect** is an optional command that runs on the remote machine, e.g. `cd ~/proj && claude`.
- **Keys and passwords.** Login is entirely `ssh`'s: keys, the agent and your config work as they do in any terminal. A password or key
  passphrase is typed in the terminal when ssh asks. The plugin stores no secret: a window (and its saved layout) keeps only the alias or
  `user@host`, the port and the remote command.
- **How it is started.** Only an argument list, never a shell string:
  `ssh -t -o ServerAliveInterval=30 -o ServerAliveCountMax=3 [-p PORT] -- DESTINATION [REMOTE_COMMAND]`. The destination must be a plain
  alias or `[user@]host` that does not start with `-`, the port 1-65535, and the remote command a single line of at most 2 KB; anything
  else is refused (in the dialog and again on the host).
- **Windows chrome.** The title bar and the list row show `⇄ user@host`; the default name is `ssh: <alias or host>`. The dot says
  **Connected** (blue-grey) while the session is up, not **Running**: the local process is always ssh.
- **Disconnected and Reconnect.** ssh exits with 255 when the link drops or was never made (wrong host, refused, timeout; the keepalives end
  a dead link in about 90 s). The window then shows **Disconnected** with a **Reconnect** button and raises an alert. There is deliberately
  no automatic retry: a password prompt would be spammed. Any other exit code means the remote session ended normally (**Exited**, ↻ to
  start again). Reconnect reuses the stored target and remote command; a restart or a reloaded saved layout connects afresh.
- **Limits (phase 1).** No Claude status signals over ssh (the hook settings file is local) and no `--settings` is added, so the agent
  dots and badges stay off; Ctrl+click on file paths is off (the paths are on the remote machine); command blocks and the real-folder
  tracking only appear if the remote shell itself emits the markers. Jump hosts work through `ProxyJump` in your ssh config.

### Safety
- Closing a terminal that is still **working or waiting** (single close, **Close all**, replacing a layout)
  asks first. Restarting a busy shell asks too.
- `⋯` → **Save log…** downloads the terminal's scrollback as a text file.

### Look
Dark/light palettes derived from VS Code Dark+/Light+ and brightened for readability: every text colour
(black aside) is at least 4.5:1 against the background, default text 15.7:1 dark / 18.5:1 light. Rounded windows with an
accent-ringed focus state, thin scrollbars, 8 px of padding inside each window. **Aa** sets the **font** (presets or
any installed font list; default `'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', Consolas,
'DejaVu Sans Mono', 'Liberation Mono', monospace` at 14 px; no ligatures, xterm draws none without an addon), size,
line height (1.2), letter spacing (0-2 px), bold weight (600) and **Contrast** (Off 1:1 / Normal 4.5:1 / High 7:1:
xterm lifts any text colour that is closer than this to its background, so grey hints stay legible; dim/faint text
gets half the ratio, so pick High if it is still too faint) for all terminals, live. Stored fonts equal to the old
12 px default move to the new defaults; a font you chose keeps its values. **Shrink font to fit window** (on by
default, in **Aa**): in narrow windows the font shrinks just enough to keep about 100 columns visible (adjustable;
never below 12 px, never above your size), so tiled terminals stay readable; a window narrower than that shows fewer
columns instead of smaller text. Text colours in the dialogs and bars are chosen from the *measured* background, so they stay legible
whatever the theme's tokens say. New terminals open first in the list and on top of the stack.

Switching tabs or sessions does **not** touch the terminals. Window layout, names, folders, favourites and
preferences are saved in `localStorage`. **Shells also outlive a page reload**: the host keeps each PTY (and
400 KB of scrollback) and the reloaded page reattaches. Saved terminals reconnect when the app starts, so counts and alerts (needs you, chime) work without opening the Terminals page. Only close, the process exiting, or restarting the
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
| `lib/git-bash.js` | Finds Git Bash wherever Git for Windows is installed |
| `lib/ssh-target.js`, `lib/ssh-config.js`, `src/client/ssh.ts` | SSH: target validation and argv (pure, shared with the browser bundle), the `~/.ssh/config` host list, client labels and socket parameters |
| `lib/paths.js`, `lib/open.js` | Clickable paths: existence check with cwd rules; opening in an editor from an argv (no shell) |
| `src/client/paths.ts`, `path-links.ts` | Path detection (pure) and the xterm link provider |
| `lib/process-table.js` | Process-table snapshots for the activity poll (PowerShell helper on Windows, `ps` elsewhere) |
| `lib/agent-signals.js` | Provider-neutral agent signals: Claude hook adapter, the generated `--settings` file |
| `lib/hook-post.js` | Command-hook forwarder Claude runs for `SessionStart` (HTTP hooks are ignored there) |
| `lib/statusline.js` | Status-line wrapper Claude runs: posts usage / sub-agent tasks to the host, relays the user's own line |
| `lib/subagents.js` | Pure per-terminal sub-agent store (status-line tasks + Start/Stop hooks, retention, cap) |
| `lib/post.js` | Shared loopback POST and stdin helpers of the two scripts above |
| `lib/shells.js`, `lib/shell/integration.ps1`, `integration.bash` | Shell table and the integration injected at spawn (command blocks, real cwd) |
| `src/client/blocks.ts`, `blocks-settings.tsx`, `blocks.css.ts` | OSC 133/633 parsing, the block model, the gutter bars, the Aa switch |
| `src/client/start.ts` | Plugin start: reconnects every saved terminal before the page is opened |
| `src/client/index.ts` | Registers the sidebar entry (`sidebar.panellist`), the page (`main`) and the header stats bar; injects the session's folder into the bar |
| `src/client/terminals-view.tsx` | The view: toolbar, window chrome, drag/resize/snap, broadcast bar |
| `src/client/shortcuts.ts` | The keyboard shortcut registry: the key handlers match with it and the help panel lists it |
| `src/client/help-panel.tsx`, `help-data.ts` | The help popover and its content (mouse actions, legends, diagnostics report) |
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
| `src/client/prompt-ready.ts` | When a fresh shell is ready for the startup command (first output, then quiet; or the shell integration's prompt-ready signal) |
| `src/client/search.ts`, `layouts.ts`, `broadcast.ts`, `preferences.ts`, `appearance.ts`, `names.ts`, `theme.ts` | Find, saved layouts, broadcast, folders and switches, font/colour prefs, window names, palette |
| `src/client/styles.ts`, `xterm.css.ts` | Stylesheets |
| `smoke-host.mjs` / `smoke-client.mjs` / `smoke-view.mjs` | Tests |

## Wire contract

`/terminal/ws?id=<session>&shell=<id>&cwd=<dir>&cols=<n>&rows=<n>` — `id` is required; if a session with that id
exists the socket reattaches to it, otherwise a shell is spawned.

For an ssh window the query is `shell=ssh&sshHost=<alias>` or `sshTarget=<[user@]host>`, plus optional `sshPort` and `sshCommand` (no `cwd`);
an invalid request is answered with an `error` frame and no process is started.

Browser → host: `{"type":"input","data"}`, `{"type":"resize","cols","rows"}`, `{"type":"signal","signal"}`,
`{"type":"kill"}` (end the shell), `{"type":"close"}` (detach only).

Host → browser: `{"type":"attached","created","replay","exited","exitCode","agent","subagents"}` (always first; `created` is true only
for a brand-new shell, which is when the startup command runs; `agent` is the last agent signal or `null`;
`subagents` is the current `SubagentInfo[]`, `[]` when none),
`{"type":"subagents","tasks":SubagentInfo[]}` (the terminal's whole sub-agent list, sent when it changes, at most about twice a second),
`{"type":"data","data"}`, `{"type":"activity","busy"}` (a program runs under the shell),
`{"type":"agent","provider","state","detail","at"}` (an agent signal; `state` is one of `idle`, `working`,
`needs-you`, `finished`, `failed`, `ended`), `{"type":"subagents","tasks"}` (full sub-agent list; `attached` also carries `subagents`), `{"type":"exit","exitCode"}`, `{"type":"error","message"}`.

### Agent signals

Each shell gets a random secret in `DSH_WT_TOKEN`. The host runs a small HTTP server on `127.0.0.1` (random port)
and writes `~/.dsh/web-terminal/claude-settings-<pid>.json` (`/api/dsh-web-terminal/info` reports the path as
`agent.claudeSettings`). That file subscribes Claude Code HTTP hooks to `POST /signal/claude` and sends the secret in
the `x-dsh-wt-token` header (interpolated from the environment). The body is Claude's hook JSON; a small adapter
(`lib/agent-signals.js`) maps events to a state. Any other tool can report by POSTing
`{"state":"needs-you","detail":"..."}` to `/signal/<provider>` with the same header. Requests with an unknown secret
get 401; bodies over 64 KB get 413.

Claude Code runs only `command` hooks for `SessionStart` (an HTTP hook there is silently ignored), so the settings file
registers `node "<plugin>/lib/hook-post.js" <url of /signal/claude>` for it (no matcher: startup, resume, clear and
compact all fire). `hook-post.js` POSTs its stdin with the same header to `127.0.0.1` only, prints nothing (its stdout
would go into Claude's context) and always exits 0; this is what turns a fresh Claude terminal from "Running" to "Idle".
Without `node` on PATH the hook is left out. Every other event stays an HTTP hook.

### Sub-agents

Three sources are merged per terminal (`lib/subagents.js`), keyed by agent id:

- `POST /signal/subagents`: the payload of the `subagentStatusLine` setting the settings file installs as
  `node "<plugin>/lib/statusline.js" --subagents <url>`. It posts Claude's `tasks` (live `tokenCount`, `model`, `status`,
  `label`/`description`, `startTime`) and then relays the user's own `subagentStatusLine` command from
  `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR` respected), or prints nothing so Claude's default rows stay.
- `SubagentStart` / `SubagentStop` HTTP hooks to `/signal/claude`: the agent appears (running) and completes
  (`status: "completed"`, `endedAt`, `agentType` kept). They carry no agent state.
- `SessionEnd`, or the shell exiting, completes every running sub-agent.

Finished sub-agents stay listed for 5 minutes (then vanish from the next frame); at most 50 per terminal. Strings are
trimmed to 200 characters, numbers must be finite. The browser gets
`SubagentInfo = {id, agentType, label, description, status, model|null, startTime|null (ms), endedAt|null (ms),
tokenCount|null, contextWindowSize|null}` in the `attached` frame and in `subagents` frames.

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
  live child process" (one OS process-table query every 3 s while any terminal is attached; on Windows one long-lived PowerShell helper answers it and exits after 30 s without terminals), shown as Running and
  used to notice an agent that died without saying so. If your Claude settings restrict hooks with
  `allowedHttpHookUrls`, add `http://127.0.0.1:*/signal/claude`.
- **Git Bash location**: found once and cached, in this order: `DSH_WT_GIT_BASH` (full path of a `bash.exe`, for an
  unusual install), the `InstallPath` of the `HKLM`/`HKCU` `SOFTWARE\GitForWindows` registry key, `git.exe` on PATH
  (mapped back to its install root), then common folders (`%LOCALAPPDATA%\Programs\Git`, `Program Files`,
  `Program Files (x86)`, Scoop). `System32\bash.exe` (the WSL launcher) is never used. If none exists the Git Bash
  entry is hidden; a missing install is re-checked every 30 s.
- **Resize** needs the 0.2.x subprocess provider (the desktop app's); older hosts skip it.
- **Security**: the PTY runs as you, unsandboxed, with the harness's full environment (credentials included) —
  that is what a terminal is. It is human-driven only and not exposed to model tool calls. The route is
  reachable wherever the harness web server is (loopback by default).
- Up to 24 concurrent shells. A second connection to the same id (e.g. another browser tab) supersedes the first.
- The page is registered under the `main` key and sidebar id `dsh-web-terminal`; the sidebar selects it by that id. On macOS the toolbar pads its top by the frame's `--dsh-frame-top-clearance`.
- Not yet: font zoom (Ctrl+wheel), per-terminal colour tags, quick-send snippets.

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
