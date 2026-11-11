// Test helper: listen on a loopback port that fetch (undici) will actually connect to.
//
// `listen(0)` lets the OS pick the port, and on some systems the pick can be one of the ports the WHATWG
// fetch standard blocks ("bad port"), which then fails the test with `TypeError: fetch failed`. This
// helper takes the OS's pick, and when it is on the blocked list closes and asks again.

/** The ports fetch refuses to connect to (https://fetch.spec.whatwg.org/#port-blocking). */
export const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/**
 * Listen on a free port of `host` that is not on the blocked list.
 * @param server - a net / http server that is not listening yet.
 * @returns the port.
 */
export async function listenLocal(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error)
      server.once('error', fail)
      server.listen(0, host, () => {
        server.removeListener('error', fail)
        resolve()
      })
    })
    const { port } = server.address()
    if (!BLOCKED_PORTS.has(port)) return port
    await new Promise((resolve) => server.close(resolve))
  }
  throw new Error('listenLocal: the OS kept handing out blocked ports')
}
