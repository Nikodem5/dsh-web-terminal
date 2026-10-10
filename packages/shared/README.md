# dsh-shared

Helpers shared by the plugins in this repo. Not installed on its own.

- `client/` is imported by relative path and bundled by each plugin's esbuild build.
- `host/` runs inside the host process, and an installed plugin cannot reach this directory. Each plugin's build copies the host modules it needs into its own `lib/shared/` (gitignored), which is installed with `lib/`.
