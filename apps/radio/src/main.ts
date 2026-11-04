import dotenv from 'dotenv'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { requireSecret } from '@packproof/shared-contracts'
import { KokoroClient, MuseScriptClient } from '@packproof/speech'
import {
  RadioLedger,
  RadioWorker,
  HttpEventSource,
  FixtureEventSource,
  LiquidsoapPlayer,
} from './index.js'
dotenv.config({ path: '.env.local', quiet: true })
const control = requireSecret(
  process.env.RADIO_CONTROL_TOKEN,
  'RADIO_CONTROL_TOKEN',
)
const dir = process.env.RADIO_DATA_DIR ?? '/data'
mkdirSync(dir, { recursive: true })
const ledger = new RadioLedger(dir + '/radio.sqlite')
const source =
  process.env.RADIO_MODE === 'fixtures'
    ? new FixtureEventSource()
    : process.env.RADIO_MODE === 'http'
      ? new HttpEventSource(
          process.env.RADIO_EVENT_SOURCE_URL ?? '',
          process.env.RADIO_EVENT_SOURCE_TOKEN ?? '',
        )
      : undefined
if (!source) throw new Error('Explicit RADIO_MODE=fixtures or http required')
const worker = new RadioWorker(
  ledger,
  source,
  new KokoroClient({
    baseUrl: process.env.KOKORO_BASE_URL ?? '',
    token: process.env.KOKORO_SERVICE_TOKEN ?? '',
    allowLocal: process.env.ALLOW_LOCAL_SERVICES === 'true',
  }),
  new MuseScriptClient({
    enabled: process.env.META_LIVE_ENABLED === 'true',
    apiKey: process.env.MODEL_API_KEY,
    maxRequests: 20,
  }),
  new LiquidsoapPlayer('liquidsoap', 1234, 'http://icecast:8000'),
  dir + '/media',
  event =>
    console.info(
      JSON.stringify({
        service: 'radio',
        event,
        source: source.fixture ? 'fixtures' : 'packproof',
      }),
    ),
)
let busy = false,
  polls = 0,
  lastSuccess = Date.now()
async function tick() {
  if (busy) return
  busy = true
  try {
    if (polls++ % 5 === 0) await worker.poll()
    await worker.tick()
    lastSuccess = Date.now()
  } catch {
    console.warn(
      JSON.stringify({ service: 'radio', event: 'poll_or_worker_failed' }),
    )
  } finally {
    busy = false
  }
}
const timer = setInterval(() => void tick(), 2000)
void tick()
const server = createServer(async (req, res) => {
  const send = (status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }
  if (req.url === '/healthz' && req.method === 'GET')
    return send(Date.now() - lastSuccess < 60000 ? 200 : 503, {
      status: Date.now() - lastSuccess < 60000 ? 'ok' : 'degraded',
      source: source.fixture ? 'fixtures' : 'packproof',
    })
  const auth = req.headers.authorization ?? ''
  const expected = 'Bearer ' + control
  if (
    auth.length !== expected.length ||
    !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
  )
    return send(401, { error: 'Unauthorized' })
  if (req.url === '/internal/status' && req.method === 'GET')
    return send(200, { events: ledger.counts() })
  if (req.url !== '/internal/playback' || req.method !== 'POST')
    return send(404, { error: 'Not found' })
  try {
    let body = ''
    for await (const b of req) {
      body += b
      if (body.length > 512) throw new Error()
    }
    const d = JSON.parse(body)
    if (
      !/^[a-f0-9]{32}$/.test(d.playbackId) ||
      !['started', 'completed'].includes(d.kind)
    )
      throw new Error()
    await worker.receipt(d.playbackId, d.kind)
    send(200, { accepted: true })
  } catch {
    send(400, { error: 'Invalid playback receipt' })
  }
})
server.requestTimeout = 5000
server.listen(8787, '0.0.0.0')
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer)
    server.close(() => ledger.close())
  })
