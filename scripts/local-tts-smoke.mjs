import { writeFileSync, mkdirSync } from 'node:fs'
import { KokoroClient } from '../packages/speech/dist/index.js'
const url = 'http://127.0.0.1:8880/v1/audio/speech'
const unauthorized = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{"input":"test"}',
})
if (unauthorized.status !== 401) throw new Error('Unprotected TTS endpoint')
const client = new KokoroClient({
  baseUrl: 'http://127.0.0.1:8880/v1',
  token: process.env.KOKORO_SERVICE_TOKEN,
  allowLocal: true,
})
const audio = await client.wav(
  'This is a PackProof demonstration. The recorded evidence does not guarantee that a physical item is genuine.',
)
mkdirSync('.runtime/artifacts', { recursive: true })
writeFileSync('.runtime/artifacts/kokoro-smoke.wav', audio)
console.log(
  JSON.stringify({
    test: 'local-kokoro',
    unauthorizedStatus: unauthorized.status,
    wavBytes: audio.length,
    path: '.runtime/artifacts/kokoro-smoke.wav',
  }),
)
