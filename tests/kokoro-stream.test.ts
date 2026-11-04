import { it, expect, vi } from 'vitest'
import { initializeLogger } from '../apps/voice-agent/node_modules/@livekit/agents/dist/index.js'
import { KokoroTTS } from '../apps/voice-agent/src/kokoro.js'
initializeLogger({ pretty: false, level: 'silent' })
it('serializes sentence requests to respect the protected service concurrency limit', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const speech = vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c
            c.enqueue(new Uint8Array(1920))
          },
        }),
      ),
  )
  const tts = new KokoroTTS({ speech })
  const options = { maxRetry: 0, timeoutMs: 5000, retryIntervalMs: 0 }
  const first = tts.synthesize('First sentence.', options)
  await first.next()
  const firstController = controller!
  const second = tts.synthesize('Second sentence.', options)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(speech).toHaveBeenCalledTimes(1)
  firstController.close()
  for await (const _ of first) {
  }
  await second.next()
  expect(speech).toHaveBeenCalledTimes(2)
  second.close()
  await tts.close()
})
it('delivers PCM frames before the HTTP body ends and marks the final frame', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      c.enqueue(new Uint8Array(1920))
    },
  })
  const tts = new KokoroTTS({ speech: async () => new Response(body) })
  const stream = tts.synthesize('Streaming test.', {
    maxRetry: 0,
    timeoutMs: 5000,
    retryIntervalMs: 0,
  })
  try {
    const first = await stream.next()
    expect(first.done).toBe(false)
    expect(first.value.final).toBe(false)
    expect(first.value.frame.sampleRate).toBe(24000)
    controller!.enqueue(new Uint8Array(960))
    controller!.close()
    const remaining = []
    for await (const frame of stream) remaining.push(frame)
    expect(remaining).toHaveLength(2)
    expect(remaining.at(-1)?.final).toBe(true)
  } finally {
    stream.close()
    await tts.close()
  }
})
it('cancels the HTTP read when synthesis is interrupted', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(1920))
    },
    cancel() {
      cancelled = true
    },
  })
  const tts = new KokoroTTS({ speech: async () => new Response(body) })
  const stream = tts.synthesize('Interruptible test.', {
    maxRetry: 0,
    timeoutMs: 5000,
    retryIntervalMs: 0,
  })
  await stream.next()
  stream.close()
  await tts.close()
  // Closing a locked reader must unblock its in-flight read too.
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(cancelled).toBe(true)
})
