// dsh-code-editor - path helpers (absolute paths from the harness may be Windows or POSIX) and language detection.

export const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** Normalise separators to `/`, drop trailing slashes; lower-cases Windows paths for comparison. */
export function normKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return isWindowsPath(p) ? s.toLowerCase() : s
}

export const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
export const dirName = (rel: string): string => {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}
export const joinRel = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
export const sameRoot = (a: string, b: string): boolean => normKey(a) === normKey(b)

/** `abs` relative to `root` (forward slashes), or null when it is not inside. */
export function relativeTo(root: string, abs: string): string | null {
  const r = normKey(root)
  const a = normKey(abs)
  if (a === r) return ''
  if (!a.startsWith(`${r}/`)) return null
  return abs.replace(/\\/g, '/').replace(/\/+$/, '').slice(r.length + 1)
}

/** The registered root that contains `abs` (the deepest one wins). */
export function findRoot(roots: readonly string[], abs: string): string | null {
  let best: string | null = null
  for (const r of roots) if (relativeTo(r, abs) !== null && (best === null || normKey(r).length > normKey(best).length)) best = r
  return best
}

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  py: 'python', pyw: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', sql: 'sql', xml: 'xml', svg: 'xml', xsd: 'xml', csproj: 'xml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', rb: 'ruby', php: 'php',
  lua: 'lua', swift: 'swift',
}
const NAMES: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'shell', '.gitignore': 'ini', '.env': 'ini', '.bashrc': 'shell', '.zshrc': 'shell' }

/** Monaco language id for a file path (plaintext when unknown). */
export function languageFor(path: string): string {
  const name = baseName(path).toLowerCase()
  if (NAMES[name]) return NAMES[name]
  if (name.startsWith('dockerfile.')) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? (EXT[name.slice(dot + 1)] ?? 'plaintext') : 'plaintext'
}
