export async function resumeVoiceAudioContext(context, timeoutMs = 5000) {
  if (!context || context.state === 'closed') return false
  if (context.state === 'running') return true

  let timeoutId = null
  try {
    const resumed = await Promise.race([
      Promise.resolve(context.resume()).then(() => true, () => false),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
    return resumed && context.state === 'running'
  } catch {
    return false
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }
}
