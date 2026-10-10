// The desktop app's native folder chooser, exposed as `globalThis.__DSH_DIRECTORY_PICKER__` ({ pick(): Promise<string|null> }).
// Absent in a plain browser: callers keep a typed-path fallback.

type Picker = { pick(): Promise<string | null> }

/** Native folder chooser exposed by the desktop app, when present. */
export function canBrowse(): boolean {
  return typeof (globalThis as { __DSH_DIRECTORY_PICKER__?: unknown }).__DSH_DIRECTORY_PICKER__ === 'object'
}

/** Ask the OS for a folder; resolves to its path or null when cancelled / unavailable. */
export async function browseFolder(): Promise<string | null> {
  const picker = (globalThis as { __DSH_DIRECTORY_PICKER__?: Picker }).__DSH_DIRECTORY_PICKER__
  if (picker === undefined || picker === null) return null
  try {
    const path = await picker.pick()
    return typeof path === 'string' && path.length > 0 ? path : null
  } catch {
    return null
  }
}
