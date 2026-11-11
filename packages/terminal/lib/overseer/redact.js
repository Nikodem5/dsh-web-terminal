// dsh-web-terminal — Overseer: remove obvious secrets from text before it is sent to a model.
//
// Terminal output and agent transcripts routinely show credentials (an `env` dump, a `cat .env`,
// a curl with an Authorization header). Everything the Overseer sends passes through `redact()`.
// It is a best-effort net for the obvious shapes, not a guarantee: the per-terminal "hide from
// Overseer" switch is the way to keep a terminal out entirely.
//
// Pure functions, no I/O.

/** What a removed secret is replaced with. */
export const REDACTED = '[REDACTED]'

/** PEM private key blocks (an unterminated one is cut to the end of the text). */
const PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g

/** `Authorization: Bearer abc` / `Proxy-Authorization: Basic abc` / `-H "authorization: token abc"`. */
const AUTH_HEADER = /\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)(\s*[:=]\s*)(?:(bearer|basic|token|digest|negotiate)\s+)?([^\s"',;]+(?:[^\S\r\n]*;[^\S\r\n]*[^\s"',;]+)*)/gi

/** A bearer token outside a header. */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Well-known token shapes (vendor prefixes, AWS ids, JWTs). */
const TOKENS = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
]

/** Credentials inside a URL: `https://user:secret@host`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)[^\s@/]+@/gi

/** Words that make a variable or field name a secret's name. */
const SECRET_WORD = '(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|key|token|secret|passwd|password|passphrase|pwd|credentials?|auth|cookie|session[_-]?id|signature)'

/**
 * `NAME=value` / `NAME: value` / `export NAME="value"` where NAME contains a secret word
 * (`OPENAI_API_KEY`, `db_password`, `GITHUB_TOKEN`...). `PWD` alone is the working folder, not a secret.
 *
 * The name is a run of letters, digits and `_.-` of at most NAME_MAX characters. The lookahead keeps this linear: without
 * it every `.` or `-` of a long run like `a.a.a.a…` starts a match that walks to the end of the run before it fails
 * (quadratic: seconds for the 72 000 characters that can reach `redact`). Now a start with no separator within NAME_MAX
 * characters ends at once.
 */
const NAME_MAX = 200
/** The most blanks between a name and its `=` or `:` (a longer run is not an assignment; unbounded it would be quadratic on a long run of spaces). */
const GAP_MAX = 40
const ASSIGNMENT = new RegExp(
  `(^|[^A-Za-z0-9_$-])(?=[A-Za-z0-9_.-]{0,${NAME_MAX}}[^\\S\\r\\n]{0,${GAP_MAX}}(?::=|=|:))((?![Pp][Ww][Dd]\\b)(?:[A-Za-z0-9]+[_.-])*${SECRET_WORD}(?:[_.-][A-Za-z0-9]+)*)([^\\S\\r\\n]*(?::=|=|:)[^\\S\\r\\n]*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"',;}]+)`,
  'gi',
)

/** `"apiKey": "value"` and other JSON / camelCase fields that hold a secret. */
const JSON_FIELD = new RegExp(`("[A-Za-z0-9_.-]*?(?:${SECRET_WORD}|apiKey|accessToken|refreshToken|idToken|clientSecret)[A-Za-z0-9_.-]*"\\s*:\\s*)"[^"\\r\\n]*"`, 'gi')

/**
 * Replace obvious secrets in `text` with `[REDACTED]`.
 * @param text - any text.
 * @returns the text with secrets replaced (unchanged when there were none).
 */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  let out = text.replace(PRIVATE_KEY, `-----BEGIN $1PRIVATE KEY$2----- ${REDACTED} -----END $1PRIVATE KEY$2-----`)
  out = out.replace(AUTH_HEADER, (_m, name, sep, scheme) => `${name}${sep}${scheme ? `${scheme} ` : ''}${REDACTED}`)
  out = out.replace(BEARER, `$1 ${REDACTED}`)
  for (const pattern of TOKENS) out = out.replace(pattern, REDACTED)
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`)
  out = out.replace(JSON_FIELD, `$1"${REDACTED}"`)
  out = out.replace(ASSIGNMENT, (match, lead, name, sep, value) => {
    const bare = value.replace(/^["']|["']$/g, '')
    if (bare.length === 0 || bare === REDACTED || bare.startsWith('[REDACTED')) return match
    // `token: 3` / `key = 1`: a count or an index, not a credential.
    if (/^\d{1,4}$/.test(bare)) return match
    return `${lead}${name}${sep}${REDACTED}`
  })
  return out
}
