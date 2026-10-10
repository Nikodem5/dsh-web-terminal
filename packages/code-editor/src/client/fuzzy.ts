// dsh-code-editor - quick-open ranking: subsequence match with bonuses for the file name, word starts and runs.

export interface Ranked { path: string; score: number; positions: number[] }

const SEP = /[\\/._\-\s]/

/** Score `query` against `path` (higher is better); null when not a subsequence. Case-insensitive. */
export function fuzzyScore(query: string, path: string): { score: number; positions: number[] } | null {
  const q = query.toLowerCase()
  const p = path.toLowerCase()
  if (q.length === 0) return { score: 0, positions: [] }
  const base = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1
  const positions: number[] = []
  let score = 0
  let from = 0
  let prev = -2
  for (let i = 0; i < q.length; i++) {
    const at = p.indexOf(q[i], from)
    if (at < 0) return null
    positions.push(at)
    let s = 1
    if (at === prev + 1) s += 5 // consecutive run
    const wordStart = at === 0 || SEP.test(p[at - 1]) || (path[at] !== path[at].toLowerCase() && path[at - 1] === path[at - 1].toLowerCase())
    if (wordStart) s += 4
    if (at >= base) s += 2
    score += s
    prev = at
    from = at + 1
  }
  const name = p.slice(base)
  if (name === q) score += 40
  else if (name.startsWith(q)) score += 20
  else if (name.includes(q)) score += 12
  score -= Math.min(10, Math.floor(p.length / 20)) // shorter paths win ties
  return { score, positions }
}

/**
 * The best `limit` matches, best first (ties: shorter path, then alphabetical).
 * An empty query lists recently opened files first, then the rest as given.
 */
export function rankFiles(query: string, files: readonly string[], limit = 50, recent: readonly string[] = []): Ranked[] {
  const out: Ranked[] = []
  if (query.trim().length === 0) {
    const seen = new Set<string>()
    const all = new Set(files)
    for (const r of recent) if (all.has(r) && !seen.has(r)) { seen.add(r); out.push({ path: r, score: 0, positions: [] }) }
    for (const f of files) { if (out.length >= limit) break; if (!seen.has(f)) out.push({ path: f, score: 0, positions: [] }) }
    return out.slice(0, limit)
  }
  const q = query.trim().replace(/\s+/g, '')
  for (const f of files) {
    const m = fuzzyScore(q, f)
    if (m) out.push({ path: f, score: m.score, positions: m.positions })
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
  return out.slice(0, limit)
}
