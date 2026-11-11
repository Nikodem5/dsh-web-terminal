// Overseer: secrets are removed before anything is sent to a model (lib/overseer/redact.js).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REDACTED, redact } from '../lib/overseer/redact.js'

const leaks = (out, secret) => assert.ok(!out.includes(secret), `leaked ${secret} in: ${out}`)

test('vendor token shapes', () => {
  const secrets = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx',
    'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'glpat-AbCdEfGhIjKlMnOpQrSt',
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA-1234567890abcdefghijklmnopqrstu',
    'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk_live_AbCdEfGhIjKlMnOpQrSt',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ]
  for (const s of secrets) {
    const out = redact(`the value is ${s} here`)
    leaks(out, s)
    assert.ok(out.includes(REDACTED))
    assert.ok(out.startsWith('the value is '))
  }
})

test('KEY=value env lines, exports, YAML-ish and JSON fields', () => {
  const text = [
    'OPENAI_API_KEY=abc123secretvalue',
    'export GITHUB_TOKEN="quoted secret value"',
    "DB_PASSWORD='p@ss w0rd'",
    'client_secret: hunter2hunter2',
    'AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    '{"apiKey": "json-secret-1", "accessToken":"json-secret-2", "name": "keep me"}',
    '$env:ANTHROPIC_AUTH_TOKEN="ps-secret"',
  ].join('\n')
  const out = redact(text)
  for (const s of ['abc123secretvalue', 'quoted secret value', 'p@ss w0rd', 'hunter2hunter2', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'json-secret-1', 'json-secret-2', 'ps-secret']) leaks(out, s)
  assert.ok(out.includes('OPENAI_API_KEY='), 'the name stays, so the model can say a key was set')
  assert.ok(out.includes('"name": "keep me"'))
})

test('ordinary text and harmless assignments are left alone', () => {
  const text = 'PWD=/home/me\nPATH=/usr/bin\nmax_tokens=4096\ntoken: 3\nmonkey=banana\nThe key point is speed.\nnpm test passed'
  assert.equal(redact(text), text)
})

test('private key blocks, also unterminated', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAA\nAAAAAQAAADMAAAALc3NoLWVk\n-----END OPENSSH PRIVATE KEY-----'
  const out = redact(`before\n${key}\nafter`)
  leaks(out, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAA')
  assert.ok(out.startsWith('before\n') && out.endsWith('\nafter'))
  const open = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nmore')
  leaks(open, 'MIIEowIBAAKCAQEA7')
})

test('Authorization headers and bearer tokens', () => {
  const out = redact([
    'curl -H "Authorization: Bearer abc.def.ghi-secret" https://api.test',
    'Proxy-Authorization: Basic dXNlcjpwYXNz',
    'x-api-key: raw-key-value',
    'Cookie: session=abc; other=def',
    'sent bearer 0123456789abcdef to the server',
  ].join('\n'))
  for (const s of ['abc.def.ghi-secret', 'dXNlcjpwYXNz', 'raw-key-value', 'session=abc', '0123456789abcdef']) leaks(out, s)
  assert.ok(out.includes('Authorization: Bearer [REDACTED]'))
})

test('credentials inside URLs', () => {
  const out = redact('git clone https://me:tok3n@github.com/x/y.git')
  leaks(out, 'tok3n')
  assert.ok(out.includes('https://me:[REDACTED]@github.com/x/y.git'))
})

test('non-strings and empty input', () => {
  assert.equal(redact(undefined), '')
  assert.equal(redact(''), '')
})
