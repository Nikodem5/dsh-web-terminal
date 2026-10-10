# DeepSeek Harness plugins

Two plugins for the DeepSeek Harness (DSH) desktop app. **Web Terminal** adds a
Terminals page for running several PTY terminals side by side, built for working with multiple Claude Code agents.
**Code Editor** adds a Code page with a Monaco editor and reviewer, git tools and markers for files an agent changed.
Everything runs locally.

## Features

**Terminals** (`dsh-web-terminal`)
- Free-form workspace of real PTY terminals: drag, resize, snap, pin; shells survive page reloads
- Attention and notifications: see which agent is working or needs you, badges, desktop notifications, optional chime
- Stats bar with Claude subscription usage (5h and 7d windows, with a forecast)
- Sub-agents panel, mission control overview, help panel (F1)
- Command blocks via shell integration (PowerShell, bash): jump between commands, failed-command flags, sticky bar
- SSH terminals from `~/.ssh/config`, clickable file paths, send a selection to another terminal

**Code** (`dsh-code-editor`)
- Monaco editor with tabs, diff editor, safe saving (detects changes on disk)
- Git tools: status, stage/unstage/discard, commit, amend, branches, fetch/pull/push, history, nested repositories
- Search in files, Markdown preview (sanitized), quick open
- "Changed by agent" markers for files a Claude session in a Terminals window edited

## Requirements

- DeepSeek Harness desktop app
- Node.js 22+ on PATH. The host runs `node` for the Claude status-line and hook helpers; without it the usage
  stats, sub-agents panel and hook-based agent signals are unavailable (terminals themselves still work)
- Git, for the editor's git features
- Optional: Claude Code CLI, for the agent features
- Windows is the primary platform, Linux is supported, macOS is untested

## Install from a release

1. Download `dsh-plugins-<version>.zip` from [GitHub Releases](https://github.com/Nikodem5/dsh-web-terminal/releases) and unzip it.
2. Close the app.
3. In the unzipped folder run `node install.mjs desktop` (or `web`; with no profile both are used). `--dry-run` previews.
4. Start the app.

To update, repeat with the newer archive. To remove: `node install.mjs --remove desktop`. Use
`--package dsh-web-terminal` or `--package dsh-code-editor` for just one plugin.

## Install from source

```
git clone https://github.com/Nikodem5/dsh-web-terminal.git
cd dsh-web-terminal
npm install
npm run build
npm run install:desktop      # or install:web; restart the app afterwards
```

`npm test` runs all tests; `npm run pack` builds the release archive into `dist/`. The installer copies each plugin
into `~/.dsh/profiles/<profile>/node_modules` (override the location with `DSH_HOME`), because linked packages outside
the profile tree do not get their browser half loaded.

## How it works

Each plugin has a host half (a Node module mounted in the DSH server: PTY sessions, file and git routes, WebSockets)
and a client half (a bundle loaded into the app UI). Servers listen on loopback only and check the Origin of browsers.
No data leaves your machine except what Claude Code itself sends.

## Security notes

- The tools assume a single-user machine: any local process can connect to the loopback servers.
- The editor reads and writes only inside folders you registered, refuses symlink escapes and `.git` internals, and
  never runs git through a shell.
- Terminals give a real shell with your privileges; that is their purpose.
- SSH uses your own `ssh` and `~/.ssh/config`; the plugin stores no passwords or keys.
- Markdown previews are sanitized and never load remote images.

## Documentation

- [Terminal plugin](packages/terminal/README.md)
- [Code editor plugin](packages/code-editor/README.md) and its [HTTP/WebSocket API](packages/code-editor/docs/API.md)
- [Shared helpers](packages/shared/README.md)

## License

[MIT](LICENSE), (c) 2026 Nikodem Marcinkiewicz
