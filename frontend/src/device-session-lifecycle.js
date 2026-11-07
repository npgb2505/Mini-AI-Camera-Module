export function createSessionOwner() {
  let generation = 0

  return {
    current() {
      return generation
    },
    advance() {
      if (generation >= Number.MAX_SAFE_INTEGER) generation = 0
      else generation += 1
      return generation
    },
    owns(token) {
      return Number.isSafeInteger(token) && token === generation
    },
  }
}

export function stopMediaStreamIfStale(stream, isCurrent) {
  if (typeof isCurrent === 'function' && isCurrent()) return false
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop() } catch {}
  }
  return true
}
