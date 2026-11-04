import { AudioByteStream, tts, type APIConnectOptions } from '@livekit/agents'
import type { AudioFrame } from '@livekit/rtc-node'
import { randomUUID } from 'node:crypto'
import { KokoroClient, voiceSettings } from '@packproof/speech'

// Kokoro accepts complete text and streams PCM. The SDK sentence adapter handles
// text chunking; unlike the generic OpenAI adapter, this never buffers full audio.
export class KokoroTTS extends tts.TTS {
  label = 'packproof.KokoroTTS'
  private lifetime = new AbortController()
  private tail = Promise.resolve()
  async acquire() {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    return release
  }
  constructor(readonly client: Pick<KokoroClient, 'speech'>) {
    super(voiceSettings.sampleRate, 1, { streaming: false })
  }
  get model() {
    return 'kokoro'
  }
  get provider() {
    return 'protected-kokoro'
  }
  synthesize(text: string, options?: APIConnectOptions, signal?: AbortSignal) {
    if (this.lifetime.signal.aborted)
      throw new Error('Kokoro service is closed')
    return new KokoroStream(
      this,
      text,
      options,
      signal
        ? AbortSignal.any([signal, this.lifetime.signal])
        : this.lifetime.signal,
    )
  }
  stream(): tts.SynthesizeStream {
    throw new Error('SDK sentence adaptation is required')
  }
  async close() {
    this.lifetime.abort()
  }
}
class KokoroStream extends tts.ChunkedStream {
  label = 'packproof.KokoroStream'
  constructor(
    private provider: KokoroTTS,
    private text: string,
    options?: APIConnectOptions,
    signal?: AbortSignal,
  ) {
    super(text, provider, options, signal)
    if (signal?.aborted) this.abortController.abort()
  }
  protected async run() {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const release = await this.provider.acquire()
    const cancel = () => void reader?.cancel().catch(() => {})
    this.abortController.signal.addEventListener('abort', cancel, {
      once: true,
    })
    try {
      if (this.abortController.signal.aborted) return
      const response = await this.provider.client.speech(
        this.text,
        'pcm',
        this.abortController.signal,
      )
      if (!response.ok || !response.body)
        throw new Error('Protected Kokoro unavailable')
      reader = response.body.getReader()
      const id = randomUUID(),
        decoder = new AudioByteStream(voiceSettings.sampleRate, 1, 480)
      let bytes = 0,
        last: AudioFrame | undefined
      const emit = (frame: AudioFrame) => {
        if (last)
          this.queue.put({
            requestId: id,
            segmentId: id,
            frame: last,
            final: false,
          })
        last = frame
      }
      while (!this.abortController.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 8 * 1024 * 1024)
          throw new Error('Kokoro audio exceeds response limit')
        for (const frame of decoder.write(value)) emit(frame)
      }
      if (this.abortController.signal.aborted) return
      if (bytes % 2) throw new Error('Incomplete Kokoro PCM sample')
      for (const frame of decoder.flush()) emit(frame)
      if (!last) throw new Error('Kokoro returned no audio')
      this.queue.put({ requestId: id, segmentId: id, frame: last, final: true })
    } catch (error) {
      if (!this.abortController.signal.aborted) throw error
    } finally {
      this.abortController.signal.removeEventListener('abort', cancel)
      await reader?.cancel().catch(() => {})
      this.queue.close()
      release()
    }
  }
}
