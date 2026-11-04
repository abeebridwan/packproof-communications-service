// Limits the actual serialized provider request, including prompts and tools.
// At the checked Meta rates, 30 requests of <=16KB input and <=2048 output
// tokens, plus <=5 minutes of STT, fit conservatively inside a US$2 lease.
export function boundedMetaFetch(fetcher: typeof fetch = fetch): typeof fetch {
  let requests = 0
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input
          : input.url,
    )
    if (
      url.toString() !== 'https://api.meta.ai/v1/chat/completions' ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new Error('Unsupported Meta request')
    if (Buffer.byteLength(init.body, 'utf8') > 16000)
      throw new Error('Meta request exceeds input limit')
    const body = JSON.parse(init.body)
    if (body.model !== 'muse-spark-1.3' || body.max_completion_tokens !== 2048)
      throw new Error('Meta model or output limit mismatch')
    if (requests++ >= 30) throw new Error('Meta session request limit reached')
    return fetcher(input, { ...init, redirect: 'error' })
  }
}
