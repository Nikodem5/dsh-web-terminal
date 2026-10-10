// dsh-code-editor - per-root UI state in localStorage (every access is try/catch: it can throw or be empty).

import { normKey } from './paths.ts'

export interface SavedTab { kind: 'file' | 'diff'; path: string; staged?: boolean }
export interface RootState { tabs: SavedTab[]; active: string | null; expanded: string[]; inline: boolean }
export interface GlobalState { lastRoot: string | null; folders: string[] }

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

const PREFIX = 'dsh-code-editor:v1:'
export const rootKey = (root: string): string => `${PREFIX}root:${normKey(root)}`
export const GLOBAL_KEY = `${PREFIX}global`

export function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function read(storage: StorageLike | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function write(storage: StorageLike | null, key: string, value: unknown): void {
  try { storage?.setItem(key, JSON.stringify(value)) } catch { /* private window / quota */ }
}

const strings = (v: unknown, max = 200): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : [])

export function loadRootState(storage: StorageLike | null, root: string): RootState {
  const v = read(storage, rootKey(root)) as Partial<RootState> | null
  const tabs: SavedTab[] = []
  if (v && Array.isArray(v.tabs)) {
    for (const t of v.tabs.slice(0, 50)) {
      if (t && typeof t === 'object' && typeof t.path === 'string' && (t.kind === 'file' || t.kind === 'diff')) {
        tabs.push(t.kind === 'diff' ? { kind: 'diff', path: t.path, staged: t.staged === true } : { kind: 'file', path: t.path })
      }
    }
  }
  return { tabs, active: typeof v?.active === 'string' ? v.active : null, expanded: strings(v?.expanded), inline: v?.inline === true }
}
export const saveRootState = (storage: StorageLike | null, root: string, state: RootState): void => write(storage, rootKey(root), state)

export function loadGlobal(storage: StorageLike | null): GlobalState {
  const v = read(storage, GLOBAL_KEY) as Partial<GlobalState> | null
  return { lastRoot: typeof v?.lastRoot === 'string' ? v.lastRoot : null, folders: strings(v?.folders, 50) }
}
export const saveGlobal = (storage: StorageLike | null, g: GlobalState): void => write(storage, GLOBAL_KEY, g)
