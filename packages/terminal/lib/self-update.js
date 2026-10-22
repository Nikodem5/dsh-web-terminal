// Update from source: pull the git clone this copy was installed from, rebuild, reinstall every plugin of the
// monorepo into this profile, and on request relaunch the desktop app so the new code loads.
//
// Only installs made by scripts/install.mjs from a clone carry `install-source.json` (repo path and commit);
// a release install has none and the feature reports itself unavailable. Every step is a fixed command with
// fixed arguments: nothing a browser sends reaches a command line.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Lines of step output kept for the panel. */
const LOG_LINES = 200

/** Absolute path of the detached relaunch helper. */
const RELAUNCH_SCRIPT = fileURLToPath(new URL('./relaunch.js', import.meta.url))

/** `<home>/profiles/<profile>/node_modules/<pkg>` -> {home, profile}, or null for any other layout. */
export function profileOf(pluginDir) {
  const modules = dirname(pluginDir)
  if (basename(modules) !== 'node_modules') return null
  const profileDir = dirname(modules)
  const profiles = dirname(profileDir)
  if (basename(profiles) !== 'profiles') return null
  return { home: dirname(profiles), profile: basename(profileDir) }
}

/** The clone recorded at install time, or null. */
export function readSource(pluginDir) {
  try {
    const source = JSON.parse(readFileSync(join(pluginDir, 'install-source.json'), 'utf8'))
    if (typeof source?.repo !== 'string' || !existsSync(join(source.repo, '.git'))) return null
    return { repo: source.repo, commit: typeof source.commit === 'string' ? source.commit : null }
  } catch {
    return null
  }
}

/**
 * The update steps, in order. npm is a .cmd shim on Windows, which Node only starts through a shell;
 * those strings are constants, so the shell sees no outside input.
 */
export function updateSteps({ repo, profile, node, branch = null, pullable = true }) {
  const win = process.platform === 'win32'
  // A branch with no tracking information has to name its remote branch explicitly.
  const pull = branch === null ? ['pull', '--ff-only'] : ['pull', '--ff-only', 'origin', branch]
  return [
    // A local-only branch has nothing on origin to pull: rebuild and reinstall what is checked out.
    ...(pullable ? [{ label: 'git pull', file: 'git', args: ['-C', repo, ...pull] }] : []),
    { label: 'npm install', file: win ? 'npm install --no-audit --no-fund' : 'npm', args: win ? [] : ['install', '--no-audit', '--no-fund'], shell: win },
    { label: 'build', file: win ? 'npm run build' : 'npm', args: win ? [] : ['run', 'build'], shell: win },
    { label: 'install', file: node, args: [join(repo, 'scripts', 'install.mjs'), profile] },
  ]
}

/**
 * @param options.pluginDir - this package's installed folder (the parent of lib/).
 * @param options.node - returns the `node` on PATH, or undefined (read when a step needs it).
 * @param options.spawnImpl - child_process.spawn; tests pass a fake.
 */
export function createSelfUpdate({ pluginDir, node, spawnImpl = spawn }) {
  const where = profileOf(pluginDir)
  /** {running, step, log, ok, error, finishedAt}; ok is null until a run ends. */
  const state = { running: false, step: null, log: [], ok: null, error: null, finishedAt: null }
  let child = null

  const append = (text) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length > 0) state.log.push(line)
    }
    if (state.log.length > LOG_LINES) state.log.splice(0, state.log.length - LOG_LINES)
  }

  const runStep = (step, cwd) =>
    new Promise((resolve, reject) => {
      append(`> ${step.label}`)
      try {
        child = spawnImpl(step.file, step.args, { cwd, shell: step.shell === true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        return reject(error)
      }
      child.stdout?.on('data', (chunk) => append(String(chunk)))
      child.stderr?.on('data', (chunk) => append(String(chunk)))
      child.on('error', reject)
      child.on('close', (code) => {
        child = null
        if (code === 0) resolve()
        else reject(new Error(`${step.label} failed (exit ${code})`))
      })
    })

  /** Why updating is unavailable, or null. */
  const unavailable = () => {
    if (where === null) return 'This copy was not installed into a dsh profile'
    if (readSource(pluginDir) === null) return 'This copy was not installed from a git clone (npm run install:desktop)'
    return null
  }

  /** Read HEAD and the branch of the clone; nulls when git cannot answer. */
  const git = (repo, args) =>
    new Promise((resolve) => {
      let out = ''
      let proc
      try {
        proc = spawnImpl('git', ['-C', repo, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        return resolve(null)
      }
      proc.stdout?.on('data', (chunk) => { out += String(chunk) })
      proc.on('error', () => resolve(null))
      proc.on('close', (code) => resolve(code === 0 ? out.trim() : null))
    })

  return {
    async status() {
      const reason = unavailable()
      const source = reason === null ? readSource(pluginDir) : null
      const [head, branch] = source === null ? [null, null] : await Promise.all([git(source.repo, ['rev-parse', 'HEAD']), git(source.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])])
      return {
        available: reason === null,
        reason,
        repo: source?.repo ?? null,
        profile: where?.profile ?? null,
        installed: source?.commit ?? null,
        head,
        branch,
        canRelaunch: relaunchUnavailable() === null,
        relaunchReason: relaunchUnavailable(),
        running: state.running,
        step: state.step,
        log: state.log.slice(),
        ok: state.ok,
        error: state.error,
        finishedAt: state.finishedAt,
      }
    },

    /** Start a run; false when one is already going or the feature is unavailable. */
    start() {
      if (state.running || unavailable() !== null) return false
      const { repo } = readSource(pluginDir)
      Object.assign(state, { running: true, step: null, log: [], ok: null, error: null, finishedAt: null })
      void (async () => {
        try {
          const nodeBin = node()
          if (nodeBin === undefined) throw new Error('node was not found on PATH')
          const upstream = await git(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])
          const current = upstream === null ? await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) : null
          const branch = current === null || current === 'HEAD' ? null : current
          // ls-remote answers an empty string when origin has no such branch (null: unreachable, let the pull report it).
          const onOrigin = branch === null ? null : await git(repo, ['ls-remote', '--heads', 'origin', branch])
          const pullable = onOrigin !== ''
          if (!pullable) append(`Branch ${branch} is not on origin: nothing to pull, rebuilding what is checked out.`)
          for (const step of updateSteps({ repo, profile: where.profile, node: nodeBin, branch, pullable })) {
            state.step = step.label
            await runStep(step, repo)
          }
          state.ok = true
          append('Installed. Restart the app to load the new version.')
        } catch (error) {
          state.ok = false
          state.error = error instanceof Error ? error.message : String(error)
          append(state.error)
        } finally {
          state.running = false
          state.step = null
          state.finishedAt = Date.now()
        }
      })()
      return true
    },

    /** Hand the restart to a detached helper; throws when this host cannot restart its app. */
    relaunch() {
      const reason = relaunchUnavailable()
      if (reason !== null) throw new Error(reason)
      const nodeBin = node()
      // Without a system node the app's own executable runs the helper as plain Node.
      const file = nodeBin ?? process.execPath
      const env = { ...process.env }
      if (nodeBin === undefined) env.ELECTRON_RUN_AS_NODE = '1'
      else delete env.ELECTRON_RUN_AS_NODE
      const helper = spawnImpl(file, [RELAUNCH_SCRIPT, String(process.ppid), String(process.pid), process.execPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
      helper.on?.('error', () => {})
      helper.unref?.()
    },

    dispose() {
      try { child?.kill() } catch {}
    },
  }
}

/**
 * Why this host cannot relaunch its app, or null. The desktop app runs the host as a child of its main
 * process with the app executable in Node mode, so `process.ppid` is the app and `process.execPath` starts it.
 * Under `dsh web` the host is plain Node and the user restarts it in their terminal.
 */
function relaunchUnavailable() {
  if (process.versions.electron === undefined) return 'Not running inside the desktop app: restart dsh yourself'
  if (process.platform !== 'win32' && process.platform !== 'linux') return 'Restart is supported on Windows and Linux only'
  if (!(process.ppid > 1)) return 'The app process is unknown'
  return null
}
