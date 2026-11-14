# Changelog

All notable changes to the `dsh-web-terminal` and `dsh-code-editor` plugins are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-14

### Added

- **Terminal:** Opt-in Antigravity CLI launcher with a status line, an installable hooks plugin and attention signals. Install or remove it from the Help panel.
- **Terminal:** Overseer panel (Ctrl+Shift+O) answers questions about your open terminals with streamed, read-only replies. All terminals are visible to it by default and you can hide individual ones. Obvious secrets are redacted first (best effort), and a one-time privacy notice appears before the first question.
- **Terminal:** Pattern alerts raise a terminal's attention badge when its output matches a text or regex pattern.
- **Terminal:** Idle-too-long alert (5 minutes by default, 0 turns it off) marks a working agent terminal "possibly hung" until its output resumes.
- **Terminal:** Notices when a new agent never becomes ready, and when copy, paste, broadcast, a file drop or typed input during a reconnect does not go through.
- **Terminal:** Git branch and dirty marker in each window header.
- **Terminal:** Colour tag per terminal.
- **Terminal:** Ctrl+wheel font zoom per terminal, with Ctrl+0 to reset.
- **Terminal:** Scrollback size and cursor style settings.
- **Terminal:** Copy on select, with a visible confirmation.
- **Terminal:** Window shortcuts: Ctrl+Alt+T opens the New terminal dialog, Ctrl+Alt+W closes the focused terminal (asks first when it is busy), Ctrl+Alt+1–9 jumps to the Nth terminal in the list, and Ctrl+Alt+M maximizes the focused terminal (again restores the layout).
- **Terminal:** Reconnect button for a window that was opened in another tab.
- **Terminal:** Dropping a file on a terminal pastes its quoted path.
- **Terminal:** Help panel's "Update from source" section: "Pull, build and install" runs git pull, npm install, the build and the installer in the clone the app was installed from (clone installs only), and "Restart app" relaunches it. Git and build steps time out and never prompt for input.
- **Repository:** CI workflow runs the tests on Windows and Linux, and a SECURITY.md is added.
- **Repository:** Both plugins are published on npm as `@nikodem5/dsh-web-terminal` and `@nikodem5/dsh-code-editor`; install with `dsh plugin --profile <profile> add <name>`.
- **Repository:** CHANGELOG.md, CONTRIBUTING.md, issue forms and a pull request template are added.

### Changed

- **Terminal:** The Agents button and panel appear only for providers that report sub-agents.
- **Terminal:** Terminal list rows and folder chips can be used from the keyboard.
- **Terminal:** The window header and terminal list show the shell's current folder.
- **Terminal:** New terminals go into the largest free gap on the canvas and cascade only when none fits.
- **Terminal:** Minimized windows are left out of saved layouts and skipped when cycling; clicking empty canvas clears focus.
- **Terminal:** Maximize is disabled on a pinned window, and the rows preset wraps into columns instead of going below the minimum window height.
- **Terminal:** An agent window keeps its shell's banner and prompt hidden until the agent is ready.
- **Terminal:** The stats bar shows limits, cost and tokens for each in-use provider, with the focused one first.
- **Terminal:** Open terminals repaint when the app theme changes, and their colours follow it.
- **Terminal:** Heavy output renders faster, using a WebGL (GPU) renderer that falls back to the DOM renderer when WebGL is unavailable or its context is lost. After a slow connection, only the missed output is sent.
- **Terminal:** Hidden or minimized windows release their GPU context and are polled less often; dragging and resizing is smoother.
- **Terminal:** README and in-app help document the Antigravity launcher, the Overseer, pattern alerts, font zoom and copy on select.
- **Repository:** Package names are now scoped (`@nikodem5/dsh-web-terminal`, `@nikodem5/dsh-code-editor`). The archive and source installers replace a 0.1.0 copy installed from this project.

### Fixed

- **Terminal:** Ctrl+Shift+C without a selection leaves the clipboard alone.
- **Terminal:** Window shortcuts stand down while a dialog, the help panel or the send menu is open.
- **Terminal:** Settings number fields keep your draft and apply on blur or Enter.
- **Terminal:** The toolbar wraps, so every control stays reachable on mid-width windows.
- **Terminal:** Saved window positions are range-checked and clamped on load.
- **Terminal:** On Windows, new terminals pick up PATH from the registry, and an agent started by its full path is recognised.
- **Terminal:** A window that never connected no longer prompts for a restart, and "busy" has one meaning across actions.
- **Terminal:** Status line commands that time out take their child processes with them.
- **Terminal:** Path checks give up on a file-system call that does not answer in time.

### Security

- **Terminal:** Every harness route and WebSocket connection now requires a loopback peer, a loopback Host header, an allowed Origin when one is sent, and a per-start token. Previously the open route had no origin or token check, and the WebSocket check let requests without an Origin header through, so a client that could reach the server (for example with `--host 0.0.0.0` or behind a tunnel) could run commands.
- **Code editor:** The same loopback and token check applies to every route and WebSocket upgrade.
- **Terminal:** On Windows, `where.exe` runs from System32, so a binary planted in the working directory is not used.
- **Terminal:** Opening a file on Windows normalizes trailing dots and spaces before the executable check, and checks a wider set of extensions.
- **Terminal:** Overseer redaction runs in linear time on long dotted text, and pattern-alert regexes that backtrack without bound are refused.

## [0.1.0] - 2026-10-11

First public release.

[0.2.0]: https://github.com/Nikodem5/dsh-web-terminal/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Nikodem5/dsh-web-terminal/releases/tag/v0.1.0
