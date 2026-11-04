/** One request/response per Connect. Assertions stay in memory and are never URL parameters. */
export function requestPackProofAssertion(
  parentOrigin: string,
): Promise<string> {
  if (new URL(parentOrigin).origin !== parentOrigin)
    throw new Error('Exact PackProof origin required')
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
    }
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== parentOrigin ||
        event.source !== window.parent ||
        event.data?.type !== 'packproof.voice.assertion' ||
        event.data?.requestId !== requestId
      )
        return
      if (
        typeof event.data.assertion !== 'string' ||
        !event.data.assertion ||
        event.data.assertion.length > 12000
      ) {
        finish()
        reject(new Error('Invalid PackProof handoff.'))
        return
      }
      finish()
      resolve(event.data.assertion)
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error('Please sign in through PackProof to start voice.'))
    }, 10000)
    window.addEventListener('message', receive)
    window.parent.postMessage(
      { type: 'packproof.voice.request-assertion', requestId },
      parentOrigin,
    )
  })
}
