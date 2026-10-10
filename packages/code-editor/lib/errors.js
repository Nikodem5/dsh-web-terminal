/** An error that maps to an HTTP response: `{ ok: false, error, code }`. */
export class EditorError extends Error {
  /**
   * @param status - HTTP status.
   * @param code - machine readable code from API.md.
   * @param message - safe, path-free message.
   * @param extra - extra JSON fields for the response body (e.g. `mtime` on conflict).
   */
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** Translate a node fs error into a path-free EditorError. */
export function fromFsError(error) {
  if (error instanceof EditorError) return error
  switch (error?.code) {
    case 'ENOENT':
      return new EditorError(404, 'enoent', 'Not found')
    case 'ENOTDIR':
      return new EditorError(404, 'enoent', 'Not a directory')
    case 'EACCES':
    case 'EPERM':
      return new EditorError(403, 'eacces', 'Permission denied')
    case 'EISDIR':
      return new EditorError(400, 'not-file', 'Is a directory')
    case 'EEXIST':
      return new EditorError(409, 'exists', 'Already exists')
    default:
      return new EditorError(500, 'io', 'I/O error')
  }
}
