// Guards for the client sources that esbuild alone does not enforce. esbuild strips TypeScript without a
// type check, so two things slip through silently: a file importing the same name twice (the last import
// wins) and two `export *` that export one name (the name is dropped from the barrel, only a debug-level
// "ambiguous-reexport" message). Both once broke the notices after a merge while the build stayed green.
// `build.mjs` and tests/client-bundle.test.mjs use this.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** esbuild message kinds raised to errors for the client bundle. */
export const STRICT_LOG_OVERRIDES = { 'ambiguous-reexport': 'error', 'duplicate-case': 'error', 'duplicate-object-key': 'error' }

const IMPORT = /^\s*import\s+(?:type\s+)?([^'";]*?)\s+from\s+['"][^'"]+['"]/gm

/** The local names an import clause binds (`a, { b, c as d, type e }, * as f`). */
export function importedNames(clause) {
  const names = []
  const braces = /\{([^}]*)\}/.exec(clause)
  if (braces) {
    for (const part of braces[1].split(',')) {
      const m = /^\s*(?:type\s+)?(?:[\w$]+\s+as\s+)?([\w$]+)\s*$/.exec(part)
      if (m) names.push(m[1])
    }
  }
  const rest = clause.replace(/\{[^}]*\}/, '')
  for (const part of rest.split(',')) {
    const m = /^\s*(?:\*\s+as\s+)?([\w$]+)\s*$/.exec(part)
    if (m) names.push(m[1])
  }
  return names
}

/** Names imported more than once by one source text. */
export function duplicateImports(code) {
  const seen = new Set()
  const dups = new Set()
  for (const m of code.matchAll(IMPORT)) {
    for (const name of importedNames(m[1])) {
      if (seen.has(name)) dups.add(name)
      seen.add(name)
    }
  }
  return [...dups]
}

/** `file: name` for every duplicate import in the .ts/.tsx files under `dir`. */
export function findDuplicateImports(dir) {
  const problems = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
    for (const name of duplicateImports(readFileSync(join(dir, entry.name), 'utf8'))) problems.push(`${entry.name}: "${name}" is imported twice`)
  }
  return problems
}
