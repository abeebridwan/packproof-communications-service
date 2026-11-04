import { setTimeout as delay } from 'node:timers/promises'
const base = 'http://127.0.0.1:8787'
let ready = false
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base + '/healthz', {
      signal: AbortSignal.timeout(1000),
    })
    if (r.ok) {
      ready = true
      break
    }
  } catch {}
  await delay(250)
}
if (!ready) throw new Error('Radio worker did not become healthy')
const unauthorized = await fetch(base + '/internal/status')
if (unauthorized.status !== 401) throw new Error('Radio control is unprotected')
const headers = {
  Authorization: 'Bearer ' + process.env.RADIO_CONTROL_TOKEN,
  'Content-Type': 'application/json',
}
const forged = await fetch(base + '/internal/playback', {
  method: 'POST',
  headers,
  body: JSON.stringify({ playbackId: '0'.repeat(32), kind: 'started' }),
})
if (forged.status !== 400) throw new Error('Forged playback receipt accepted')
const status = await fetch(base + '/internal/status', { headers })
if (!status.ok) throw new Error('Radio status unavailable')
console.log(
  JSON.stringify({
    test: 'radio-control',
    unauthorizedStatus: unauthorized.status,
    forgedReceiptStatus: forged.status,
    ...(await status.json()),
  }),
)
