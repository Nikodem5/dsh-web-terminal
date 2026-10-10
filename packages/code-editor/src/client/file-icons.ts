// dsh-code-editor - file name -> icon. Pure data (no DOM): the badge is drawn by file-icon.tsx as a tiny inline SVG,
// a rounded square in a brand-ish colour with a 1-3 character label. The fill and the label colour are fixed per
// type and chosen to read on both the dark and the light surface, so no theme switch is needed.

export interface FileIconSpec {
  /** Stable key (tests, `data-icon`). */
  id: string
  /** Text inside the badge (empty = draw the plain file outline instead). */
  label: string
  bg: string
  fg: string
}

const W = '#ffffff'
const K = '#1b1b1b'
const spec = (id: string, label: string, bg: string, fg: string = W): FileIconSpec => ({ id, label, bg, fg })

const GENERIC = spec('file', '', '#8a8f98')

const JS = spec('js', 'JS', '#f1c40f', K)
const TS = spec('ts', 'TS', '#3178c6')
const JSON_ = spec('json', '{}', '#c9a227', K)
const SH = spec('shell', '>_', '#4e9a3a')
const IMG = spec('image', 'IMG', '#2a9d8f')
const CPP = spec('cpp', 'C+', '#d6336c')
const CSS = spec('css', '#', '#7952b3')
const XML = spec('xml', '<>', '#0b6fb8')

const BY_EXT: Record<string, FileIconSpec> = {
  md: spec('md', 'MD', '#2f81c0'), markdown: spec('md', 'MD', '#2f81c0'), mdx: spec('md', 'MD', '#2f81c0'),
  js: JS, mjs: JS, cjs: JS, jsx: spec('jsx', 'JSX', '#20a4c4'),
  ts: TS, mts: TS, cts: TS, tsx: spec('tsx', 'TSX', '#3178c6'),
  json: JSON_, jsonc: JSON_, json5: JSON_,
  py: spec('py', 'PY', '#3b72a8'), pyw: spec('py', 'PY', '#3b72a8'),
  ps1: spec('ps', 'PS', '#1f4f8f'), psm1: spec('ps', 'PS', '#1f4f8f'), psd1: spec('ps', 'PS', '#1f4f8f'),
  sh: SH, bash: SH, zsh: SH, bat: SH, cmd: SH,
  css: CSS, scss: spec('scss', 'SC', '#c6538c'), sass: spec('scss', 'SC', '#c6538c'), less: spec('less', 'LS', '#2b4a80'),
  html: spec('html', 'H', '#e44d26'), htm: spec('html', 'H', '#e44d26'), vue: spec('vue', 'V', '#3fa876'), svelte: spec('svelte', 'S', '#e1431b'),
  yml: spec('yaml', 'YML', '#b5333a'), yaml: spec('yaml', 'YML', '#b5333a'),
  toml: spec('toml', 'TML', '#9c5a2b'), ini: spec('ini', 'INI', '#7a7f87'), cfg: spec('ini', 'INI', '#7a7f87'), conf: spec('ini', 'INI', '#7a7f87'),
  go: spec('go', 'GO', '#00a7c7'), rs: spec('rust', 'RS', '#c0663a'),
  java: spec('java', 'J', '#b0561c'), kt: spec('kotlin', 'KT', '#7f52ff'), kts: spec('kotlin', 'KT', '#7f52ff'),
  c: spec('c', 'C', '#5a6bb0'), h: spec('h', 'H', '#7d86b8'), cpp: CPP, cc: CPP, cxx: CPP, hpp: spec('hpp', 'H+', '#d6336c'), hh: spec('hpp', 'H+', '#d6336c'),
  cs: spec('cs', 'C#', '#2e8b2e'), csproj: spec('cs', 'C#', '#2e8b2e'), sln: spec('cs', 'C#', '#2e8b2e'),
  sql: spec('sql', 'SQL', '#d9822b'), xml: XML, xsd: XML, xsl: XML, svg: spec('svg', 'SVG', '#e8a317', K),
  png: IMG, jpg: IMG, jpeg: IMG, gif: IMG, webp: IMG, ico: IMG, bmp: IMG, avif: IMG, tiff: IMG,
  lock: spec('lock', 'LK', '#7d8590'),
  rb: spec('ruby', 'RB', '#cc342d'), php: spec('php', 'PHP', '#6c78b5'), lua: spec('lua', 'LUA', '#2c3e8f'), swift: spec('swift', 'SW', '#f05138'),
  txt: spec('text', 'TXT', '#7d8590'), log: spec('text', 'LOG', '#7d8590'),
  env: spec('env', 'ENV', '#c9a227', K),
  zip: spec('archive', 'ZIP', '#8a6d3b'), gz: spec('archive', 'GZ', '#8a6d3b'), tgz: spec('archive', 'TGZ', '#8a6d3b'), '7z': spec('archive', '7Z', '#8a6d3b'),
  pdf: spec('pdf', 'PDF', '#d33f3f'),
}

const BY_NAME: Record<string, FileIconSpec> = {
  'package.json': spec('npm', 'NPM', '#cb3837'),
  'package-lock.json': spec('npm', 'NPM', '#9c2b2a'),
  dockerfile: spec('docker', 'DK', '#1d8fd0'),
  '.dockerignore': spec('docker', 'DK', '#1d8fd0'),
  '.gitignore': spec('git', 'GIT', '#e2552d'),
  '.gitattributes': spec('git', 'GIT', '#e2552d'),
  '.gitmodules': spec('git', 'GIT', '#e2552d'),
  '.env': spec('env', 'ENV', '#c9a227', K),
  makefile: SH,
  'tsconfig.json': TS,
  'jsconfig.json': JS,
}

/** The icon for a file by its base name (not a path): well-known names first, then README / LICENSE / Dockerfile.*, then the extension. */
export function fileIconFor(fileName: string): FileIconSpec {
  const name = fileName.toLowerCase()
  const named = BY_NAME[name]
  if (named) return named
  if (/^readme(\.|$)/.test(name)) return spec('readme', 'i', '#2f81c0')
  if (/^(licen[cs]e|copying)(\.|$)/.test(name)) return spec('license', '(c)', '#a8793a')
  if (name.startsWith('dockerfile.')) return BY_NAME.dockerfile
  if (name.startsWith('.env.')) return BY_NAME['.env']
  const dot = name.lastIndexOf('.')
  if (dot < 0) return GENERIC
  return BY_EXT[name.slice(dot + 1)] ?? GENERIC
}
