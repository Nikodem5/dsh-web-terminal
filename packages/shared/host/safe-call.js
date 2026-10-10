/** Run a provider call, swallowing both synchronous throws and async rejections. */
export function safeCall(fn) {
  try {
    Promise.resolve(fn()).catch(() => {})
  } catch {}
}
