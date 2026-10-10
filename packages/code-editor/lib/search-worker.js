// Worker thread for search.js: runs one job ({ type: 'walk' | 'locate', ... }) and posts progress + the result.
// The parent terminates the thread on timeout, so a catastrophic regular expression only costs this thread.
import { parentPort, workerData } from 'node:worker_threads'
import { locateHits, walkSearch } from './search-core.js'

const send = (message) => parentPort.postMessage(message)

try {
  const job = workerData
  const emit = (results) => send({ type: 'progress', results })
  const done =
    job.type === 'walk'
      ? await walkSearch(job.rootReal, job.params, emit)
      : locateHits(job.hits, job.params, emit)
  send({ type: 'done', ...done })
} catch (error) {
  send({ type: 'error', code: error?.code, status: error?.status, message: String(error?.message ?? error) })
}
