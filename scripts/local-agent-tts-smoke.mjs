import { TTS } from '../apps/voice-agent/node_modules/@livekit/agents-plugin-openai/dist/index.js'
import { initializeLogger } from '../apps/voice-agent/node_modules/@livekit/agents/dist/index.js'
import { writeFileSync } from 'node:fs'
initializeLogger({ pretty: false, level: 'error' })
const tts = new TTS({
  model: 'kokoro',
  voice: 'af_heart',
  apiKey: process.env.KOKORO_SERVICE_TOKEN,
  baseURL: 'http://127.0.0.1:8880/v1',
  sampleRate: 24000,
})
let samples = 0
const chunks = []
try {
  for await (const event of tts.synthesize(
    'PackProof checks recorded evidence. This is a local voice adapter test.',
  )) {
    if (!event.frame) continue
    const frame = event.frame
    if (frame.sampleRate !== 24000 || frame.channels !== 1)
      throw new Error('Wrong PCM format')
    samples += frame.samplesPerChannel
    chunks.push(
      Buffer.from(
        frame.data.buffer,
        frame.data.byteOffset,
        frame.data.byteLength,
      ),
    )
  }
  if (!samples) throw new Error('No playable speech')
  writeFileSync('.runtime/artifacts/livekit-kokoro.pcm', Buffer.concat(chunks))
  console.log(
    JSON.stringify({
      test: 'livekit-node-kokoro-tts',
      sampleRate: 24000,
      channels: 1,
      samples,
      seconds: samples / 24000,
    }),
  )
} finally {
  await tts.close()
}
