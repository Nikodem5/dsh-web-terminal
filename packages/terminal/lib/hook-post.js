// dsh-web-terminal — command-hook forwarder (runs inside Claude Code, not the host).
//
// Claude Code only runs `command` hooks for SessionStart (HTTP hooks are ignored there), so this
// script stands in for the HTTP hook: it POSTs the hook JSON from stdin to `argv[2]` with the
// terminal's secret (env DSH_WT_TOKEN). It prints NOTHING: SessionStart stdout is added to
// Claude's context. Always exits 0.

import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postJson, readStdin } from './post.js'

async function main() {
  const input = await readStdin()
  const token = process.env.DSH_WT_TOKEN
  const url = process.argv[2]
  if (token && url && input.length > 0) await postJson(url, token, input, 2000)
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => { process.exitCode = 0 })
}
