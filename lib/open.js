// Opening a clicked path in an editor. Everything is spawned from an argv array without a shell, so
// a path can never be interpreted as a command; the one exception (a .cmd shim on Windows with no
// real executable beside it) goes through cmd.exe only after the arguments pass a strict filter.

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, win32 } from 'node:path'

export const TARGETS = ['vscode', 'cursor', 'default', 'custom']
export const MAX_TEMPLATE_LENGTH = 500
const MAX_PATH_LENGTH = 4096

/** What "OS default app" must never launch: opening these runs them rather than showing them. */
const EXECUTABLE_EXT = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.msi', '.msp', '.scr', '.pif', '.lnk', '.url', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.cpl', '.reg', '.jar', '.desktop', '.sh', '.appimage', '.command', '.app', '.workflow'])

/** Error with a message the browser shows verbatim. */
export class OpenError extends Error {}

/**
 * Split a template into arguments the way a shell would for quotes only: whitespace separates, single
 * or double quotes group. Backslashes are literal (Windows paths), so there is no escaping.
 */
export function splitTemplate(template) {
  const args = []
  let cur = ''
  let has = false
  let quote = null
  for (const ch of template) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur.length > 0) args.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
    }
  }
  if (quote !== null) throw new OpenError('Custom command has an unclosed quote')
  if (has || cur.length > 0) args.push(cur)
  return args
}

/**
 * Substitute {file} {line} {col} {dir} into each argument separately (so a path with spaces stays one
 * argument). A missing {line}/{col} written after a ':' is dropped together with that colon; anywhere
 * else it becomes 1. A column without a line is ignored.
 * @returns the argv, command first.
 */
export function templateToArgv(template, { file, line, col }) {
  const l = Number.isInteger(line) && line > 0 ? line : undefined
  const c = l !== undefined && Number.isInteger(col) && col > 0 ? col : undefined
  const dir = dirname(file)
  const args = splitTemplate(template).map((arg) =>
    arg
      .replace(/(:?)\{(line|col)\}/g, (_m, colon, name) => {
        const v = name === 'line' ? l : c
        return v !== undefined ? `${colon}${v}` : colon === ':' ? '' : '1'
      })
      .replace(/\{file\}/g, () => file)
      .replace(/\{dir\}/g, () => dir),
  )
  if (args.length === 0) throw new OpenError('Custom command is empty')
  return args
}

/** `file:line:col` the way `code -g` wants it. */
export function gotoArg(file, line, col) {
  if (!Number.isInteger(line) || line < 1) return file
  return Number.isInteger(col) && col > 0 ? `${file}:${line}:${col}` : `${file}:${line}`
}

/** True when nothing in the string could be read by cmd.exe as syntax. */
const cmdSafe = (s) => !/["%^&|<>!`\r\n]/.test(s)

const EDITORS = {
  vscode: { name: 'code', exe: 'Code.exe', label: 'VS Code' },
  cursor: { name: 'cursor', exe: 'Cursor.exe', label: 'Cursor' },
}

/**
 * Build the opener.
 * @param deps - `spawn` and `which` (injected in tests so no editor ever launches), `platform`.
 */
export function createOpener({ spawn = nodeSpawn, which, platform = process.platform, exists = existsSync, statFn = stat } = {}) {
  /** Run argv detached; resolves once the process exists, rejects on spawn failure. */
  const launch = (file, args, opts = {}) =>
    new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts })
      } catch (error) {
        reject(error)
        return
      }
      const timer = setTimeout(resolve, 400)
      timer.unref?.()
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('spawn', () => { clearTimeout(timer); resolve() })
      child.unref?.()
    })

  /** Spawn an executable; a Windows .cmd/.bat shim is run through cmd.exe with filtered arguments. */
  const run = async (file, args, notFound) => {
    try {
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
        if (![file, ...args].every(cmdSafe)) throw new OpenError('Refusing to run a command script with special characters in the path')
        const quote = (s) => (/\s/.test(s) ? `"${s}"` : s)
        return await launch('cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], { windowsVerbatimArguments: true })
      }
      return await launch(file, args)
    } catch (error) {
      if (error instanceof OpenError) throw error
      throw new OpenError(error?.code === 'ENOENT' ? notFound : `Could not start the program (${error?.code ?? error?.message})`)
    }
  }

  /** Find an editor's launcher. On Windows prefer the real .exe next to the .cmd shim: spawning a .cmd needs a shell. */
  const findEditor = async (name, exeName) => {
    if (platform !== 'win32') return (await which(name)) ?? undefined
    const shim = await which(`${name}.cmd`)
    if (shim !== undefined) {
      const bin = win32.dirname(shim)
      // VS Code: <root>\bin\code.cmd; Cursor: <root>\resources\app\bin\cursor.cmd.
      for (const candidate of [win32.join(bin, '..', exeName), win32.join(bin, '..', '..', '..', exeName)]) if (exists(candidate)) return candidate
      return shim
    }
    return (await which(`${name}.exe`)) ?? undefined
  }

  const openDefault = (file) => {
    if (platform === 'win32') return run('explorer.exe', [file], 'explorer.exe not found')
    if (platform === 'darwin') return run('open', [file], 'open not found')
    return run('xdg-open', [file], 'xdg-open not found (install xdg-utils)')
  }

  /**
   * Open a path.
   * @param body - `{path, line?, col?, target, template?}` from the browser (untrusted).
   * @throws OpenError, whose message is safe to show.
   */
  return async function open(body) {
    if (body === null || typeof body !== 'object') throw new OpenError('Bad request')
    const { path: file, line, col, target, template } = body
    if (typeof file !== 'string' || file.length === 0 || file.length > MAX_PATH_LENGTH || file.includes('\0')) throw new OpenError('Bad path')
    if (!TARGETS.includes(target)) throw new OpenError('Unknown target')
    const n = (v) => (Number.isInteger(v) && v > 0 && v < 1e9 ? v : undefined)
    let info
    try {
      info = await statFn(file)
    } catch {
      throw new OpenError('That path no longer exists')
    }
    // A folder goes to the file manager whatever the target: no editor opens it usefully with -g.
    if (info.isDirectory()) return openDefault(file)
    if (target === 'default') {
      if (EXECUTABLE_EXT.has(extname(file).toLowerCase())) throw new OpenError(`Not opening ${basename(file)} with the OS default app: that would run it. Pick an editor in Aa.`)
      return openDefault(file)
    }
    if (target === 'custom') {
      if (typeof template !== 'string' || template.length === 0 || template.length > MAX_TEMPLATE_LENGTH) throw new OpenError('Set a custom command in Aa first')
      if (!template.includes('{file}')) throw new OpenError('Custom command must contain {file}')
      const [cmd, ...args] = templateToArgv(template, { file, line: n(line), col: n(col) })
      let exe = cmd
      if (platform === 'win32' && !/[\\/]/.test(cmd) && !/\.\w+$/.test(cmd)) exe = (await which(cmd)) ?? cmd
      return run(exe, args, `Command not found: ${cmd}`)
    }
    const editor = EDITORS[target]
    const exe = await findEditor(editor.name, editor.exe)
    if (exe === undefined) throw new OpenError(`${editor.label} not found on PATH`)
    return run(exe, ['-g', gotoArg(file, n(line), n(col))], `${editor.label} not found on PATH`)
  }
}
