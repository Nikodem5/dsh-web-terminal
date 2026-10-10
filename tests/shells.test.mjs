// Shell integration, host half: the argv each shell is started with, and the real scripts run in a real PTY.
//
// The PTY tests need node-pty (found next to the harness install) and the shell itself; each is skipped when missing.
//
//   npm test   (or: node --test tests/shells.test.mjs)

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHELL_DIR, integrationEnabled, integrationKind, psQuote, shellSpec } from '../lib/shells.js'

const dir = SHELL_DIR.replaceAll('\\', '/')

test('the integration scripts ship inside lib/ (install.mjs copies lib/ whole)', () => {
  assert.ok(existsSync(join(SHELL_DIR, 'integration.ps1')))
  assert.ok(existsSync(join(SHELL_DIR, 'integration.bash')))
})

test('PowerShell 5.1 and 7: profile first, then the script is dot-sourced from text', () => {
  for (const [id, file] of [['powershell', 'powershell.exe'], ['pwsh', 'pwsh.exe']]) {
    const spec = shellSpec(id, { platform: 'win32', env: {} })
    assert.equal(spec.file, file)
    assert.equal(spec.integrated, true)
    assert.deepEqual(spec.args, ['-NoLogo', '-NoExit', '-Command', `. ([scriptblock]::Create([IO.File]::ReadAllText('${dir}integration.ps1')))`])
  }
})

test('PowerShell: a quote or space in the plugin path survives', () => {
  const spec = shellSpec('powershell', { platform: 'win32', env: {}, shellDir: "C:\\Users\\O'Neil\\my plugin\\lib\\shell\\" })
  assert.equal(spec.args[3], ". ([scriptblock]::Create([IO.File]::ReadAllText('C:/Users/O''Neil/my plugin/lib/shell/integration.ps1')))")
  assert.equal(psQuote("a'b"), "'a''b'")
})

test('Git Bash: --rcfile replaces -l (a login shell ignores the rcfile) and the script replays the login files', () => {
  const spec = shellSpec('gitbash', { platform: 'win32', env: {}, shellDir: 'C:\\a b\\shell\\' })
  assert.deepEqual(spec.args, ['--rcfile', 'C:/a b/shell/integration.bash', '-i'])
  assert.deepEqual(spec.env, { DSH_WT_BASH_LOGIN: '1' })
})

test('POSIX bash: plain interactive with --rcfile, no login emulation', () => {
  const spec = shellSpec('bash', { platform: 'linux', env: {} })
  assert.deepEqual(spec.args, ['--rcfile', `${dir}integration.bash`, '-i'])
  assert.equal(spec.env, undefined)
  // The default shell follows $SHELL.
  assert.deepEqual(shellSpec('default', { platform: 'linux', env: { SHELL: '/usr/bin/bash' } }).args.slice(0, 1), ['--rcfile'])
})

test('shells without integration keep their stock arguments', () => {
  assert.deepEqual(shellSpec('cmd', { platform: 'win32', env: {} }), { file: 'cmd.exe', args: [], integrated: false })
  assert.deepEqual(shellSpec('wsl', { platform: 'win32', env: {} }), { file: 'wsl.exe', args: [], integrated: false })
  assert.deepEqual(shellSpec('sh', { platform: 'linux', env: {} }).args, ['-i'])
  assert.deepEqual(shellSpec('zsh', { platform: 'linux', env: {} }).args, ['-i'])
  assert.deepEqual(shellSpec('default', { platform: 'linux', env: { SHELL: '/usr/bin/zsh' } }).args, ['-i'])
})

test('integration off (per launch or by environment) gives the stock arguments back', () => {
  assert.deepEqual(shellSpec('powershell', { platform: 'win32', env: {}, integration: false }).args, ['-NoLogo'])
  assert.deepEqual(shellSpec('gitbash', { platform: 'win32', env: {}, integration: false }).args, ['-i', '-l'])
  assert.deepEqual(shellSpec('bash', { platform: 'linux', env: { DSH_WT_SHELL_INTEGRATION: '0' } }).args, ['-i'])
  assert.equal(integrationEnabled({ DSH_WT_SHELL_INTEGRATION: 'false' }), false)
  assert.equal(integrationEnabled({ DSH_WT_SHELL_INTEGRATION: '1' }), true)
  assert.equal(integrationEnabled({}), true)
})

test('integrationKind', () => {
  assert.equal(integrationKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'ps')
  assert.equal(integrationKind('/usr/bin/pwsh'), 'ps')
  assert.equal(integrationKind('C:/Program Files/Git/bin/bash.exe'), 'bash')
  assert.equal(integrationKind('/bin/zsh'), undefined)
  assert.equal(integrationKind('C:\\Windows\\System32\\cmd.exe'), undefined)
})

// ── real shells ──

const nodePty = (() => {
  try {
    const base = join(homedir(), 'deepseek-harness', 'node_modules', '.pnpm')
    const pkg = readdirSync(base).find((d) => d.startsWith('node-pty@'))
    return pkg === undefined ? undefined : createRequire(import.meta.url)(join(base, pkg, 'node_modules', 'node-pty'))
  } catch {
    return undefined
  }
})()

/** The plugin's scripts copied under a folder with a space in its name, so quoting is exercised for real. */
const spacedRoot = mkdtempSync(join(tmpdir(), 'dsh wt '))
const spacedShellDir = (() => {
  const shellDir = join(spacedRoot, 'lib', 'shell')
  mkdirSync(shellDir, { recursive: true })
  cpSync(SHELL_DIR, shellDir, { recursive: true })
  return shellDir + '/'
})()
after(() => rmSync(spacedRoot, { recursive: true, force: true }))

const ENTER = String.fromCharCode(13)

/** Kill the shell and everything it started (conpty children outlive p.kill() on Windows), then wait for it to be gone. */
function killTree(p) {
  return new Promise((done) => {
    const gone = setTimeout(done, 5000)
    p.onExit(() => { clearTimeout(gone); done() })
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      else p.kill()
    } catch {}
    try { p.kill() } catch {}
  })
}

/**
 * Type `lines` into a shell, one at a time: the next line goes in only once the shell has drawn the next
 * prompt (a new OSC 133;B), so nothing depends on how fast the machine is. Resolves with everything the shell
 * wrote, up to the second time the sentinel text appears (once as the typed command, once as its output).
 * The deadline is generous: a cold PowerShell under parallel test load can take many seconds to start.
 * The shell tree is always killed before this settles.
 * @returns the raw output.
 */
async function runShell(file, args, env, lines, cwd) {
  const p = nodePty.spawn(file, args, { cols: 200, rows: 40, cwd, env: { ...process.env, ...env } })
  let out = ''
  let finished = false
  let sent = 0
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`shell timed out; saw ${JSON.stringify(out.slice(-300))}`)), 40000)
      p.onExit(() => { if (!finished) reject(new Error(`shell exited early; saw ${JSON.stringify(out.slice(-300))}`)) })
      p.onData((d) => {
        if (finished) return
        out += d
        if (out.split('DSH_DONE_MARK').length > 2) {
          finished = true
          resolve()
          return
        }
        const prompts = out.split(']133;B').length - 1
        // Line k is typed once prompt k+1 is out (prompt 1 is the first one).
        while (sent < lines.length && prompts >= sent + 1) {
          try { p.write(lines[sent++] + ENTER) } catch (e) { finished = true; reject(e); return }
        }
      })
    })
  } finally {
    finished = true
    clearTimeout(timer)
    await killTree(p)
  }
  return out
}

/** The 133/633 payloads in the order the shell wrote them: `A`, `B`, `C`, `D;3`, `E;cmd`, `P;Cwd=...`. */
function sequences(out) {
  return [...out.matchAll(/\x1b\](?:133|633);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map((m) => m[1])
}

const unescape = (s) => s.replace(/\\(\\|x[0-9a-f]{2})/gi, (_, g) => (g === '\\' ? '\\' : String.fromCharCode(parseInt(g.slice(1), 16))))

/** What each finished command was and exited with. */
function commandsOf(seq) {
  const done = []
  let command
  for (const s of seq) {
    if (s.startsWith('E;')) command = unescape(s.slice(2))
    else if (s.startsWith('D;')) {
      done.push({ command, exit: Number(s.slice(2)) })
      command = undefined
    }
  }
  return done
}

const powershell = process.platform === 'win32' && nodePty !== undefined && existsSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')

test('real PowerShell 5.1 (-NoProfile): blocks in order, exit codes, nothing else printed', { skip: !powershell, timeout: 60000 }, async () => {
  const spec = shellSpec('powershell', { platform: 'win32', env: {}, shellDir: spacedShellDir })
  const out = await runShell(spec.file, ['-NoProfile', ...spec.args], undefined, ['echo hi', 'cmd /c exit 3', 'Get-Item nonexistent-xyz', 'cmd /c exit 0', 'Write-Output DSH_DONE_MARK', ''], tmpdir())
  const seq = sequences(out)
  assert.deepEqual(commandsOf(seq).slice(0, 4), [
    { command: 'echo hi', exit: 0 },
    { command: 'cmd /c exit 3', exit: 3 },
    { command: 'Get-Item nonexistent-xyz', exit: 1 }, // the previous command's $LASTEXITCODE must not leak in
    { command: 'cmd /c exit 0', exit: 0 },
  ])
  assert.deepEqual(seq.slice(0, 4).map((s) => s.split('=')[0]), ['P;Cwd', 'A', 'B', 'E;echo hi'])
  assert.equal(seq.filter((s) => s === 'C').length, seq.filter((s) => s.startsWith('D;')).length + 1)
  assert.match(seq[0], /^P;Cwd=.*[\\/]/)
  // The prompt text is still there, and loading printed no error text.
  assert.match(out, /PS [A-Z]:\\.*>/)
  assert.doesNotMatch(out, /ParserError|Unexpected token|is not recognized|integration.ps1|dshWt/)
})

test('real PowerShell 5.1: loading twice keeps one wrapper, and a profile prompt is wrapped, not replaced', { skip: !powershell, timeout: 60000 }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh prof '))
  const profile = join(profileDir, 'p.ps1')
  writeFileSync(profile, "function prompt { Write-Host -NoNewline 'MYPROMPT'; ' > ' }\n")
  const spec = shellSpec('powershell', { platform: 'win32', env: {}, shellDir: spacedShellDir })
  const load = spec.args[3]
  const out = await runShell(spec.file, ['-NoProfile', '-NoLogo', '-NoExit', '-Command', `. '${profile.replaceAll('\\', '/')}'; ${load}; ${load}`], undefined, ['echo hi', 'Write-Output DSH_DONE_MARK', ''], tmpdir())
  const seq = sequences(out)
  assert.match(out, /MYPROMPT/)
  assert.equal(seq.filter((s) => s === 'A').length, seq.filter((s) => s === 'B').length)
  assert.deepEqual(commandsOf(seq).slice(0, 1), [{ command: 'echo hi', exit: 0 }])
  assert.equal(seq.filter((s) => s === 'C').length, seq.filter((s) => s.startsWith('D;')).length + 1)
  rmSync(profileDir, { recursive: true, force: true })
})

const gitBash = process.platform === 'win32' && nodePty !== undefined ? ['C:/Program Files/Git/bin/bash.exe'].find(existsSync) : undefined
const posixBash = process.platform !== 'win32' && nodePty !== undefined ? ['/bin/bash', '/usr/bin/bash'].find(existsSync) : undefined
for (const [label, file, id, platform] of [['Git Bash', gitBash, 'gitbash', 'win32'], ['bash', posixBash, 'bash', 'linux']]) {
  for (const forceDebug of [false, true]) {
    test(`real ${label}${forceDebug ? ' (DEBUG-trap fallback)' : ''}: blocks, exit codes, user PROMPT_COMMAND and PS1 kept`, { skip: file === undefined, timeout: 60000 }, async () => {
      const home = mkdtempSync(join(tmpdir(), 'dsh home '))
      writeFileSync(join(home, '.bashrc'), "PS1='my> '\nPROMPT_COMMAND='echo \"PC:$?\"'\n")
      writeFileSync(join(home, '.bash_profile'), '. "$HOME/.bashrc"\n')
      const spec = shellSpec(id, { platform, env: {}, shellDir: spacedShellDir })
      const env = { ...spec.env, HOME: home, DSH_WT_FORCE_DEBUG_TRAP: forceDebug ? '1' : '' }
      const out = await runShell(file, spec.args, env, ['echo hi', 'false', '(exit 7)', 'echo "a;b\\c"', 'cd /tmp', 'echo DSH_DONE_MARK', ''], tmpdir())
      const seq = sequences(out)
      assert.deepEqual(commandsOf(seq).slice(0, 4), [
        { command: 'echo hi', exit: 0 },
        { command: 'false', exit: 1 },
        { command: '(exit 7)', exit: 7 },
        { command: 'echo "a;b\\c"', exit: 0 },
      ])
      // C comes straight after the command is accepted, E (read from history) and D once it ended.
      const first = seq.slice(seq.indexOf('B'), seq.indexOf('D;0') + 1)
      assert.deepEqual(first.map((s) => s.split(';')[0]), ['B', 'C', 'E', 'D'])
      // The user's PROMPT_COMMAND still ran with the right $?, and their PS1 is still the prompt.
      assert.match(out, /PC:1/)
      assert.match(out, /PC:7/)
      assert.match(out, /my> /)
      assert.ok(seq.some((s) => s.startsWith('P;Cwd=')))
      rmSync(home, { recursive: true, force: true })
    })
  }
}
