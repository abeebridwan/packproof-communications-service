import { it, expect, vi } from 'vitest'
import { boundedMetaFetch } from '../apps/voice-agent/src/meta-limits.js'
const url = 'https://api.meta.ai/v1/chat/completions'
const options = (extra = {}) => ({
  method: 'POST',
  body: JSON.stringify({
    model: 'muse-spark-1.3',
    max_completion_tokens: 2048,
    ...extra,
  }),
})
it('limits all serialized Meta attempts including failed requests and transport retries', async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 503 }))
  const send = boundedMetaFetch(fetcher)
  for (let i = 0; i < 30; i++)
    expect((await send(url, options())).status).toBe(503)
  await expect(send(url, options())).rejects.toThrow('request limit')
  expect(fetcher).toHaveBeenCalledTimes(30)
})
it('rejects excessive UTF-8 request bytes and provider/model/output changes before network access', async () => {
  const fetcher = vi.fn(async () => new Response('{}'))
  const send = boundedMetaFetch(fetcher)
  await expect(
    send(url, options({ messages: [{ content: '界'.repeat(6000) }] })),
  ).rejects.toThrow('input limit')
  await expect(
    send('https://untrusted.example/v1/chat/completions', options()),
  ).rejects.toThrow('Unsupported')
  await expect(send(url, options({ model: 'other' }))).rejects.toThrow(
    'mismatch',
  )
  await expect(
    send(url, options({ max_completion_tokens: 4096 })),
  ).rejects.toThrow('mismatch')
  expect(fetcher).not.toHaveBeenCalled()
  expect((await send(url, options())).status).toBe(200)
})
