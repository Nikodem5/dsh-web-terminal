# Contributing

This repository holds two plugins for the DeepSeek Harness (DSH) desktop app, in one npm-workspaces monorepo.

## Prerequisites

- Node.js 22 or newer (`engines` in `package.json`; CI uses 22)
- Git (the Code plugin's git features need it)
- A DSH install to try the plugins in. Plugins are copied into a DSH profile, so run the app at least once first

## Setup

```
npm install
npm run build
npm test
```

- `npm run build` bundles the client code of both plugins and copies the shared host helpers.
- `npm test` runs the tests of every package plus the root tests in `tests/`. The terminal tests start real shells.

## Trying a local build in DSH

The installer copies each plugin into `~/.dsh/profiles/<profile>/node_modules`. Use it instead of `dsh plugin add <path>`:
a linked package outside the profile does not get its browser half loaded.

```
npm run install:desktop                                     # profile "desktop"
npm run install:web                                         # profile "web"
npm run install:dry                                         # preview both, write nothing
node scripts/install.mjs desktop --package dsh-code-editor  # one plugin only
node scripts/install.mjs --remove desktop                   # uninstall
```

Set `DSH_HOME` to install somewhere other than `~/.dsh`. Restart the DSH app afterwards, because plugins load at boot.
An install made from a clone can later be updated from the help panel (F1, then **Update from source**).

## Repository layout

| Path | Contents |
|---|---|
| `packages/terminal` | `dsh-web-terminal`: the Terminals page (PTY terminals, agent status, SSH) |
| `packages/code-editor` | `dsh-code-editor`: the Code page (Monaco editor, git tools, search) |
| `packages/shared` | Helpers used by both plugins |
| `scripts/` | `install.mjs` (profile installer) and `pack-release.mjs` (release archive, `npm run pack`) |
| `tests/` | Root-level tests, run by `npm test` |
| `.github/` | CI workflow, issue forms and the pull request template |

## Pull requests

- One topic per PR. A bug fix and an unrelated refactor belong in two PRs.
- CI runs `npm ci`, `npm run build` and `npm test` on `windows-latest` and `ubuntu-latest`. Both must pass; run `npm test` locally before opening the PR.
- Describe how you verified the change in the PR description: the tests you ran, and whether you tried it in a DSH profile and on which OS.

## Commit messages

Follow the existing log. Use a short imperative subject in one line, without a trailing period. An area prefix followed by a colon is common. Examples from the history:

```
Pattern alerts: refuse regexes that backtrack without bound
CI: scope workflow to main and fix Node 22 / Linux test mocks
Redaction: bound the assignment name and URL scheme matches so a long a.a.a run is linear
```

Put the reasoning in the commit body when the subject does not say enough.

## Security

Do not report vulnerabilities in a public issue or pull request. See [SECURITY.md](SECURITY.md) for the private reporting route.

## License

Contributions are accepted under the project's [MIT license](LICENSE).
