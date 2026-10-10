// Git Bash resolution: order, WSL-launcher exclusion and caching, with every machine lookup injected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGitBashResolver, gitRootFromExe, isWslLauncher } from '../lib/git-bash.js'

/** A resolver over a fake machine: `files` exist, `registry` maps keys to InstallPath, `git` is what PATH finds. */
function machine({ files = [], registry = {}, git, env = {} } = {}) {
  const present = new Set(files.map((f) => f.toLowerCase()))
  const calls = { reg: 0, which: 0 }
  const clock = { t: 0 }
  const resolver = createGitBashResolver({
    env,
    exists: (file) => present.has(file.toLowerCase()),
    reg: async (key) => { calls.reg++; return registry[key] },
    which: async () => { calls.which++; return git },
    now: () => clock.t,
  })
  return { resolver, calls, clock, present }
}

const PF = 'C:\\Program Files\\Git\\bin\\bash.exe'
const USER = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'

test('env override wins over the registry', async () => {
  const { resolver } = machine({
    files: ['D:\\tools\\bash.exe', PF],
    registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Program Files\\Git' },
    env: { DSH_WT_GIT_BASH: 'D:\\tools\\bash.exe' },
  })
  assert.equal(await resolver.resolve(), 'D:\\tools\\bash.exe')
})

test('an override pointing nowhere is ignored', async () => {
  const { resolver } = machine({ files: [PF], registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Program Files\\Git' }, env: { DSH_WT_GIT_BASH: 'D:\\gone\\bash.exe' } })
  assert.equal(await resolver.resolve(), PF)
})

test('registry: HKLM first, then HKCU', async () => {
  const both = machine({
    files: [PF, USER],
    registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Program Files\\Git', 'HKCU\\SOFTWARE\\GitForWindows': 'C:\\Users\\me\\AppData\\Local\\Programs\\Git' },
  })
  assert.equal(await both.resolver.resolve(), PF)
  const userOnly = machine({ files: [USER], registry: { 'HKCU\\SOFTWARE\\GitForWindows': 'C:\\Users\\me\\AppData\\Local\\Programs\\Git' } })
  assert.equal(await userOnly.resolver.resolve(), USER)
})

test('a stale registry value falls through to PATH', async () => {
  const m = machine({
    files: ['E:\\git\\bin\\bash.exe'],
    registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Uninstalled' },
    git: 'E:\\git\\cmd\\git.exe',
  })
  assert.equal(await m.resolver.resolve(), 'E:\\git\\bin\\bash.exe')
})

test('PATH: both git.exe layouts map back to the root', async () => {
  const cmd = machine({ files: ['E:\\git\\bin\\bash.exe'], git: 'E:\\git\\cmd\\git.exe' })
  assert.equal(await cmd.resolver.resolve(), 'E:\\git\\bin\\bash.exe')
  const mingw = machine({ files: ['E:\\git\\bin\\bash.exe'], git: 'E:\\git\\mingw64\\bin\\git.exe' })
  assert.equal(await mingw.resolver.resolve(), 'E:\\git\\bin\\bash.exe')
  assert.equal(gitRootFromExe('C:\\Users\\me\\scoop\\shims\\git.exe'), undefined)
})

test('common locations: per-user, x86 and Scoop', async () => {
  const user = machine({ files: [USER], env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } })
  assert.equal(await user.resolver.resolve(), USER)
  const x86 = machine({ files: ['C:\\Program Files (x86)\\Git\\bin\\bash.exe'], env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } })
  assert.equal(await x86.resolver.resolve(), 'C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  const scoop = machine({ files: ['C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe'], env: { USERPROFILE: 'C:\\Users\\me' } })
  assert.equal(await scoop.resolver.resolve(), 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe')
})

test('never picks the WSL launcher, even as an override or via PATH', async () => {
  assert.equal(isWslLauncher('C:\\Windows\\System32\\bash.exe'), true)
  assert.equal(isWslLauncher('C:/Windows/sysnative/bash.exe'), true)
  assert.equal(isWslLauncher(PF), false)
  const sys = 'C:\\Windows\\System32\\bash.exe'
  const m = machine({ files: [sys], env: { DSH_WT_GIT_BASH: sys, SystemRoot: 'C:\\Windows' }, registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Windows\\System32' }, git: 'C:\\Windows\\System32\\git.exe' })
  assert.equal(await m.resolver.resolve(), undefined)
})

test('the answer is cached; a miss is retried only after the TTL', async () => {
  const hit = machine({ files: [PF], registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Program Files\\Git' } })
  await hit.resolver.resolve()
  await hit.resolver.resolve()
  assert.equal(hit.calls.reg, 1)

  const miss = machine()
  assert.equal(await miss.resolver.resolve(), undefined)
  const first = miss.calls.reg
  assert.equal(await miss.resolver.resolve(), undefined)
  assert.equal(miss.calls.reg, first, 'miss served from cache')
  miss.present.add(PF.toLowerCase())
  miss.clock.t = 60_000
  assert.equal(await miss.resolver.resolve(), PF, 'found after Git is installed and the TTL passed')
})

test('a cached path that disappears is looked up again', async () => {
  const m = machine({ files: [PF], registry: { 'HKLM\\SOFTWARE\\GitForWindows': 'C:\\Program Files\\Git' } })
  assert.equal(await m.resolver.resolve(), PF)
  m.present.delete(PF.toLowerCase())
  assert.equal(await m.resolver.resolve(), undefined)
})
