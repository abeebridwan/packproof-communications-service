// Explicit live-provider test: real browser/LiveKit audio, synthetic microphone.
// It does not establish that a person's physical microphone works.
import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { SignJWT } from '../apps/gateway/node_modules/jose/dist/webapi/index.js'
import { KokoroClient } from '../packages/speech/dist/index.js'

if (
  !process.argv.includes('--run-live') ||
  process.env.META_LIVE_ENABLED !== 'true'
)
  throw new Error(
    'Explicit --run-live and approved live Meta configuration required',
  )
const tts = new KokoroClient({
  baseUrl: process.env.KOKORO_BASE_URL,
  token: process.env.KOKORO_SERVICE_TOKEN,
})
const utterances = [
  'The product ID is zero zero seven one eight four two.',
  'Yes, that is the exact code. Please check it.',
  'Is it genuine?',
  'Thank you. Please end this call.',
]
const audio = []
for (const text of utterances)
  audio.push(Buffer.from(await tts.wav(text)).toString('base64'))
const invitation = await new SignJWT({})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer('packproof-voice-invite')
  .setAudience('packproof-voice-gateway')
  .setSubject('synthetic-browser-' + randomUUID())
  .setJti(randomUUID())
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(process.env.VOICE_INVITE_SECRET))
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
})
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  permissions: ['microphone'],
})
page.setDefaultTimeout(3000)
const evidence = {
  testedAt: new Date().toISOString(),
  scope:
    'synthetic microphone; real browser, deployed agent and providers; fixture PackProof data',
  states: [],
  pageErrors: 0,
}
page.on('pageerror', error => {
  evidence.pageErrors++
  evidence.errors ??= []
  let message = error.message.replace(
    /eyJ[A-Za-z0-9_.-]{40,}/g,
    '[REDACTED_JWT]',
  )
  for (const [name, value] of Object.entries(process.env))
    if (/SECRET|TOKEN|API_KEY|PASSWORD/.test(name) && value?.length > 15)
      message = message.replaceAll(value, '[REDACTED]')
  evidence.errors.push(message.slice(0, 400))
})
await page.addInitScript(() => {
  const ac = new AudioContext({ sampleRate: 48000 })
  const destination = ac.createMediaStreamDestination()
  navigator.mediaDevices.getUserMedia = async () => {
    await ac.resume()
    return new MediaStream([destination.stream.getAudioTracks()[0].clone()])
  }
  const seen = new Set(),
    analysers = []
  window.__voiceSmoke = {
    maxRemoteRms: 0,
    async play(base64) {
      await ac.resume()
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
      const source = ac.createBufferSource()
      source.buffer = await ac.decodeAudioData(bytes.buffer)
      source.connect(destination)
      await new Promise(resolve => {
        source.onended = resolve
        source.start()
      })
    },
    sample() {
      for (const element of document.querySelectorAll('audio')) {
        const stream = element.srcObject
        if (!(stream instanceof MediaStream) || seen.has(stream.id)) continue
        seen.add(stream.id)
        const analyser = ac.createAnalyser()
        analyser.fftSize = 2048
        ac.createMediaStreamSource(stream).connect(analyser)
        analysers.push(analyser)
      }
      for (const analyser of analysers) {
        const samples = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(
          samples.reduce((s, v) => s + v * v, 0) / samples.length,
        )
        this.maxRemoteRms = Math.max(this.maxRemoteRms, rms)
      }
      return this.maxRemoteRms
    },
  }
  setInterval(() => window.__voiceSmoke.sample(), 100)
})
async function waitFor(check, label, timeout = 35000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const snapshot = await page.evaluate(() => ({
      status: document.querySelector('.status')?.textContent,
      transcript: document.querySelector('.transcript')?.innerText,
      error: document.querySelector('[role=alert]')?.textContent,
    }))
    const status = snapshot.status
    if (snapshot.transcript) evidence.transcript = snapshot.transcript
    if (status && evidence.states.at(-1) !== status)
      evidence.states.push(status)
    if (await check().catch(() => false)) return
    const alert = snapshot.error
    if (alert) throw new Error('UI error during ' + label)
    await page.waitForTimeout(250)
  }
  throw new Error('Timed out: ' + label)
}
try {
  await page.goto('http://127.0.0.1:5173/')
  await page.getByText('Authorized demo access', { exact: true }).click()
  await page.getByLabel('Short-lived invitation').fill(invitation)
  await page.getByRole('button', { name: 'Connect microphone' }).click()
  await waitFor(
    async () =>
      /Listening/.test((await page.locator('.status').textContent()) ?? ''),
    'agent ready',
    60000,
  )
  evidence.connected = true
  await page.getByLabel('Short-lived invitation').fill('')
  await page.evaluate(data => window.__voiceSmoke.play(data), audio[0])
  await waitFor(
    async () =>
      /I heard/.test((await page.locator('.transcript').textContent()) ?? ''),
    'identifier readback',
  )
  await waitFor(
    async () =>
      /Listening/.test((await page.locator('.status').textContent()) ?? ''),
    'readback finished',
  )
  evidence.identifierReadback = true
  await page.evaluate(data => window.__voiceSmoke.play(data), audio[1])
  await waitFor(
    async () =>
      (await page.getByRole('heading', { name: /0071842/ }).count()) > 0,
    'fixture verification result',
  )
  await waitFor(
    async () =>
      /Listening/.test((await page.locator('.status').textContent()) ?? ''),
    'verification speech finished',
  )
  evidence.verificationResult = await page.locator('article').innerText()
  const before = await page.locator('.transcript').innerText()
  await page.evaluate(data => window.__voiceSmoke.play(data), audio[2])
  await waitFor(
    async () =>
      (await page.locator('.transcript').innerText()).length >
      before.length + 30,
    'follow-up transcript',
  )
  await waitFor(
    async () =>
      /Listening/.test((await page.locator('.status').textContent()) ?? ''),
    'follow-up speech finished',
  )
  evidence.followUp = true
  evidence.transcript = await page.locator('.transcript').innerText()
  evidence.maxRemoteAudioRms = await page.evaluate(() =>
    window.__voiceSmoke.sample(),
  )
  await page.screenshot({
    path: '.runtime/artifacts/cloud-browser-voice.png',
    fullPage: true,
  })
  await page.evaluate(data => window.__voiceSmoke.play(data), audio[3])
  await waitFor(
    async () =>
      (await page
        .getByRole('button', { name: 'Connect microphone', exact: true })
        .count()) > 0,
    'normal termination',
  )
  evidence.ended = true
  if (!(evidence.maxRemoteAudioRms > 0.001))
    throw new Error('No decoded remote speech detected')
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.failure = error.message
  process.exitCode = 1
  evidence.transcript = await page
    .locator('.transcript')
    .innerText()
    .catch(() => evidence.transcript ?? '')
  evidence.maxRemoteAudioRms = await page
    .evaluate(() => window.__voiceSmoke.sample())
    .catch(() => 0)
  await page
    .screenshot({
      path: '.runtime/artifacts/cloud-browser-voice-failure.png',
      fullPage: true,
    })
    .catch(() => {})
} finally {
  const disconnect = page.getByRole('button', {
    name: 'Disconnect',
    exact: true,
  })
  if (await disconnect.count()) await disconnect.click().catch(() => {})
  await browser.close()
  mkdirSync('.runtime/artifacts', { recursive: true })
  writeFileSync(
    '.runtime/artifacts/cloud-browser-voice.json',
    JSON.stringify(evidence, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(JSON.stringify(evidence))
}
