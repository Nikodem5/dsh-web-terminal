# DeepSeek Harness plugins

A monorepo of plugins for the DeepSeek Harness web GUI (npm workspaces).

| Package | Name | Status |
|---|---|---|
| [`packages/terminal`](packages/terminal/README.md) | `dsh-web-terminal` | Interactive PTY terminals, command blocks, SSH, agent status. Full documentation in its README |
| [`packages/code-editor`](packages/code-editor/README.md) | `dsh-code-editor` | Monaco-based code editor and reviewer (host half done, see its README) |
| [`packages/shared`](packages/shared/README.md) | `dsh-shared` | Helpers used by more than one plugin. Not installed on its own |
| `scripts/install.mjs` | | The one installer for all plugin packages |

## Build, test, install

```powershell
npm install                       # once, at the repo root
npm run build                     # builds every package (lib/client.js, lib/shared/)
npm test                          # runs every package's tests
npm run install:desktop           # = node scripts/install.mjs desktop
```

Installer usage: `node scripts/install.mjs [--remove] [--dry-run] [--package <name>|all] [profile ...]`. With no
profile it targets `desktop` and `web`; with no `--package` it installs every plugin package that has a `dsh`
manifest and is built. `--dry-run` prints what would be copied or removed without writing. Restart the app after
installing: plugins load at boot.

Each plugin is copied into `~/.dsh/profiles/<profile>/node_modules/<package name>` (`lib/`, `package.json`,
`cordis.patch.yml`), so an installed package never reaches back into this repo. Shared host code is therefore copied
into the plugin's own `lib/shared/` at build time, while shared client code is bundled by esbuild.
