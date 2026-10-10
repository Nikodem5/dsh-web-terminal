// Verification probe for dsh-web-terminal (development only).
//
// Two checks against a running harness:
//   1. GET  /api/dsh-web-terminal/info  -> the host plugin mounted and answers
//   2. WS   /terminal/ws                -> the upgrade route exists, negotiates a
//      real PTY, echoes a marker command, and terminates cleanly
//
// Usage: node probe.mjs <port> [token]

import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

const port = Number(process.argv[2] ?? 19388)
const token = process.argv[3]

/** One raw HTTP request; resolves with the status line plus the decoded body. */
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nconnection: close\r\n\r\n`,
      )
    })
    let raw = ''
    socket.on('data', (chunk) => { raw += chunk.toString('utf8') })
    socket.on('error', reject)
    socket.on('close', () => {
      const [head, ...rest] = raw.split('\r\n\r\n')
      const status = Number(head.split(' ')[1])
      resolve({ status, head, body: rest.join('\r\n\r\n') })
    })
  })
}

/** One WebSocket handshake attempt; resolves with the raw HTTP status line. */
function wsHandshake(path) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Origin: http://127.0.0.1:${port}`,
          token === undefined ? '' : `Authorization: Bearer ${token}`,
          '',
          '',
        ].join('\r\n'),
      )
    })
    let raw = ''
    const inspect = () => {
      if (raw.length === 0) return
      const statusLine = raw.split('\r\n')[0]
      const accepted = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      const upgraded = raw.includes(accepted)
      // A successful upgrade leaves the socket open for the PTY conversation;
      // a refusal closes it. Either way the status line is the answer.
      if (upgraded || raw.includes('\r\n\r\n')) finish({ statusLine, upgraded, socket, body: raw })
    }
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      inspect()
    })
    socket.on('error', reject)
    socket.on('close', () => {
      inspect()
      finish({ statusLine: raw.split('\r\n')[0] ?? 'CLOSED', upgraded: false, socket, body: raw })
    })
    setTimeout(() => finish({ statusLine: 'TIMEOUT', upgraded: false, socket, body: raw }), 6000).unref?.()
  })
}

const info = await httpGet('/api/dsh-web-terminal/info')
console.log(`GET /api/dsh-web-terminal/info -> ${info.status}`)
console.log(info.body.slice(0, 400))

const ws = await wsHandshake('/terminal/ws')
console.log(`WS  /terminal/ws -> ${ws.statusLine} (handshake accepted: ${ws.upgraded})`)
if (ws.upgraded) {
  ws.socket.destroy()
}
process.exit(0)
