// dsh-web-terminal — the opt-in Antigravity CLI integration (host half).
//
// Nothing here runs unless the user presses Install in the Terminals help panel. Two parts:
//  - launch time (no global change): with the integration on, the client starts `agy --settings <file>`,
//    a per-session settings file (agy never saves it) whose `statusLine` runs lib/agy-statusline.mjs;
//  - a small agy plugin with hooks (agy loads hooks only from hooks.json files, never from settings): it is
//    staged in the plugin's data folder and installed with `agy plugin install <folder>`; Remove runs
//    `agy plugin uninstall dsh-web-terminal`.
// agy runs hook and status-line commands through `cmd /c` / `sh -c` and mangles double quotes on Windows,
// so commands carry no quotes: hooks run `node hook.mjs <Event>` from the plugin's own folder (agy's working
// directory for a hooks.json), and the status line needs a path without spaces.

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGY_PLUGIN_NAME = 'dsh-web-terminal'
const HOOK_SOURCE = fileURLToPath(new URL('./agy-hook.mjs', import.meta.url))
const STATUSLINE_SOURCE = fileURLToPath(new URL('./agy-statusline.mjs', import.meta.url))
/** Hook events the plugin subscribes to (see providers/antigravity-signals.js). */
export const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop']
const STATE_FILE = 'agy-integration.json'
const STALE_SETTINGS = /^agy-settings-(\d+)\.json$/
const RUN_TIMEOUT_MS = 60_000

/** The plugin's hooks.json: one named group, quote-free commands run from the plugin folder. */
export function buildAgyHooks() {
  const handler = (event) => ({ type: 'command', command: `node hook.mjs ${event}`, timeout: 5 })
  const group = {}
  for (const event of AGY_HOOK_EVENTS) group[event] = event === 'PostToolUse' ? [{ matcher: '*', hooks: [handler(event)] }] : [handler(event)]
  return { [AGY_PLUGIN_NAME]: group }
}

/** The plugin's manifest. */
export function buildAgyManifest(version) {
  return {
    name: AGY_PLUGIN_NAME,
    displayName: 'DSH Web Terminal',
    version: version ?? '0.1.0',
    description: 'Reports agent state, the conversation id and changed files to the DeepSeek Harness Terminals page. Does nothing in terminals the page did not open.',
  }
}

/**
 * The `--settings` file for one host: its status line runs the wrapper. The user's own padding and
 * stacking are kept; with no status line of their own the built-in one stays (stack_with_default).
 * @returns the settings object, or undefined when the wrapper path cannot be written without quotes.
 */
export function buildAgySettings(statuslineScript, user) {
  const script = statuslineScript.replaceAll('\\', '/')
  if (/[\s"'&|<>^%]/.test(script)) return undefined
  const statusLine = { type: 'command', command: `node ${script}` }
  if (user === undefined) statusLine.stack_with_default = true
  else {
    if (user.padding !== undefined) statusLine.padding = user.padding
    if (user.stackWithDefault !== undefined) statusLine.stack_with_default = user.stackWithDefault
  }
  return { statusLine }
}

/** True when nothing in the string could be read by cmd.exe as syntax. */
const cmdSafe = (s) => !/["%^&|<>!`\r\n]/.test(s)

/**
 * The argv that runs agy at `file` with `args`. Node cannot spawn a script shim directly on Windows (it fails with
 * EINVAL), and `where agy` may list the extensionless npm shim first: prefer a real .exe, run a .cmd / .bat through
 * `cmd.exe /d /s /c` once every part passes a strict filter (no quotes, %, ^, &, |, <, >, !), and otherwise say why not.
 * Elsewhere the file is run as it is.
 * @returns {{argv: string[], verbatim?: boolean} | {error: string}} `verbatim`: pass the arguments to spawn unquoted (cmd.exe parses them).
 */
export function agyCommand(file, args, { platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return { argv: [file, ...args] }
  let target = file
  if (!/\.[a-z0-9]+$/i.test(basename(file.replaceAll('\\', '/')))) target = ['.exe', '.com', '.cmd', '.bat'].map((ext) => file + ext).find((candidate) => exists(candidate)) ?? file
  if (/\.(exe|com)$/i.test(target)) return { argv: [target, ...args] }
  if (/\.(cmd|bat)$/i.test(target)) {
    if (![target, ...args].every(cmdSafe)) return { error: 'agy is a command script and its path or arguments contain characters cmd.exe would read as syntax' }
    const quote = (part) => (/\s/.test(part) ? `"${part}"` : part)
    return { argv: ['cmd.exe', '/d', '/s', '/c', `"${[target, ...args].map(quote).join(' ')}"`], verbatim: true }
  }
  return { error: `agy was found at ${file} but it is neither an .exe nor a .cmd, so it cannot be started from here` }
}

/** Run a command; resolves {code, out} (code null when it could not start or timed out). */
function runCommand(argv, { env, timeoutMs = RUN_TIMEOUT_MS, verbatim = false } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, windowsVerbatimArguments: verbatim })
    } catch (error) {
      return resolve({ code: null, out: error instanceof Error ? error.message : String(error) })
    }
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (c) => { out += String(c) })
    child.stderr.on('data', (c) => { out += String(c) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, out: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

/** The last non-empty line of a command's output, for an error message. */
const lastLine = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? ''

/**
 * @param options.dir - the plugin's data folder (state, staged plugin, settings files).
 * @param options.geminiDir - agy's config folder (tests point it elsewhere; never written to here).
 * @param options.pid - this host's process id (the settings file name).
 * @param options.nodePath - `node` on PATH (the hooks and status line run under it); undefined when missing.
 * @param options.findAgy - () => Promise<string|undefined>: agy's path.
 * @param options.agyArgv - argv prefix that runs agy instead of the found path (tests).
 * @param options.run - command runner (tests): (argv, {env, verbatim}) => Promise<{code, out}>.
 * @param options.platform - tests only.
 * @param options.exists - file check (tests only).
 * @param options.version - the plugin version written into the manifest.
 * @param options.userStatusLine - () => the user's own agy status line (see agy-statusline.mjs).
 * @param options.pidAlive - for sweeping settings files of dead hosts.
 */
export function createAgyIntegration({ dir, geminiDir, pid, nodePath, findAgy, agyArgv, run = runCommand, version, userStatusLine = () => undefined, pidAlive = () => true, env, platform = process.platform, exists = existsSync }) {
  const stageDir = join(dir, 'agy-plugin')
  const stateFile = join(dir, STATE_FILE)
  const settingsFile = join(dir, `agy-settings-${pid}.json`)
  const installedManifest = join(geminiDir, 'config', 'plugins', AGY_PLUGIN_NAME, 'plugin.json')
  /** The change in progress: {action, promise}. */
  let busy = null
  let lastError = null

  const enabled = () => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'))?.enabled === true
    } catch {
      return false
    }
  }

  /** Write (or remove) this host's --settings file to match the state; the path when it is usable. */
  const syncSettings = () => {
    if (!enabled() || nodePath === undefined) {
      rmSync(settingsFile, { force: true })
      return undefined
    }
    const settings = buildAgySettings(STATUSLINE_SOURCE, userStatusLine())
    if (settings === undefined) return undefined
    mkdirSync(dir, { recursive: true })
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
    return settingsFile
  }

  const agy = async (args) => {
    if (agyArgv !== undefined) return run([...agyArgv, ...args], { env })
    const path = await findAgy()
    if (path === undefined) return { code: null, out: '`agy` was not found on PATH' }
    const command = agyCommand(path, args, { platform, exists })
    if ('error' in command) return { code: null, out: command.error }
    return run(command.argv, { env, verbatim: command.verbatim === true })
  }

  const stage = () => {
    rmSync(stageDir, { recursive: true, force: true })
    mkdirSync(stageDir, { recursive: true })
    writeFileSync(join(stageDir, 'plugin.json'), `${JSON.stringify(buildAgyManifest(version), null, 2)}\n`)
    writeFileSync(join(stageDir, 'hooks.json'), `${JSON.stringify(buildAgyHooks(), null, 2)}\n`)
    copyFileSync(HOOK_SOURCE, join(stageDir, 'hook.mjs'))
  }

  const status = () => {
    const on = enabled()
    const pluginInstalled = existsSync(installedManifest)
    let settingsPath
    let writeError = null
    try {
      settingsPath = on ? syncSettings() : undefined
    } catch (error) {
      writeError = `could not write the launch settings: ${errorText(error)}`
    }
    let reason = null
    if (nodePath === undefined) reason = 'node not on PATH'
    else if (writeError !== null) reason = writeError
    else if (on && settingsPath === undefined) reason = 'the status-line wrapper path contains spaces or quotes'
    else if (on && !pluginInstalled) reason = 'the agy plugin is not installed (hooks are off)'
    return { enabled: on, pluginInstalled, busy: busy !== null, reason, error: lastError }
  }

  /** What a request for a different change gets while one runs: the state as it is, and why nothing was done. */
  const busyStatus = (wanted) => ({ ...status(), error: `busy: ${busy.action === 'install' ? 'an install' : 'a removal'} is still running, so the ${wanted} was not started` })

  // Leftover settings files of hosts that are gone.
  try {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const stale = STALE_SETTINGS.exec(name)
      if (stale !== null && Number(stale[1]) !== pid && !pidAlive(Number(stale[1]))) rmSync(join(dir, name), { force: true })
    }
  } catch {}

  return {
    status,
    /** What the client needs to start agy: `{settingsPath}` when on, `{}` otherwise (start as typed). */
    launch() {
      let path
      try {
        path = enabled() ? syncSettings() : undefined
      } catch {}
      return path === undefined ? {} : { settingsPath: path }
    },
    /** Stage and install the plugin, then turn the launch-time part on. One at a time. */
    install() {
      if (busy !== null && busy.action !== 'install') return Promise.resolve(busyStatus('install'))
      busy ??= {
        action: 'install',
        promise: (async () => {
          lastError = null
          if (nodePath === undefined) {
            lastError = 'node is not on PATH: the hooks and status line run under node'
            return
          }
          try {
            stage()
          } catch (error) {
            lastError = `could not write the plugin files: ${errorText(error)}`
            return
          }
          const result = await agy(['plugin', 'install', stageDir])
          if (result.code !== 0) {
            lastError = `agy plugin install failed${result.out ? `: ${lastLine(result.out)}` : ''}`
            return
          }
          try {
            mkdirSync(dir, { recursive: true })
            writeFileSync(stateFile, `${JSON.stringify({ version: 1, enabled: true, installedAt: Date.now() })}\n`)
            syncSettings()
          } catch (error) {
            lastError = `the agy plugin is installed but the integration could not be turned on (${errorText(error)}); Remove undoes the install`
          }
        })().finally(() => { busy = null }),
      }
      return busy.promise.then(status)
    },
    /** Uninstall the plugin and turn the launch-time part off. */
    remove() {
      if (busy !== null && busy.action !== 'remove') return Promise.resolve(busyStatus('remove'))
      busy ??= {
        action: 'remove',
        promise: (async () => {
          lastError = null
          try {
            rmSync(stateFile, { force: true })
            syncSettings()
            if (existsSync(installedManifest)) {
              const result = await agy(['plugin', 'uninstall', AGY_PLUGIN_NAME])
              if (result.code !== 0) lastError = `agy plugin uninstall failed${result.out ? `: ${lastLine(result.out)}` : ''}`
            }
            if (lastError === null) rmSync(stageDir, { recursive: true, force: true })
          } catch (error) {
            lastError = `could not turn the integration off: ${errorText(error)}`
          }
        })().finally(() => { busy = null }),
      }
      return busy.promise.then(status)
    },
    dispose() {
      rmSync(settingsFile, { force: true })
    },
  }
}

