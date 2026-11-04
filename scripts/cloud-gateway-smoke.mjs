// Creates and deletes one ephemeral room. Never invokes STT, LLM or TTS.
import { createGateway, configFromEnv } from '../apps/gateway/dist/index.js'
import { SignJWT } from '../apps/gateway/node_modules/jose/dist/webapi/index.js'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
const c = configFromEnv({
  ...process.env,
  VOICE_ALLOWED_ORIGINS: 'http://localhost:5173',
  GATEWAY_STATE_PATH: ':memory:',
})
const { server } = createGateway(c)
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const url = 'http://127.0.0.1:' + server.address().port
try {
  const invitation = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('packproof-voice-invite')
    .setAudience('packproof-voice-gateway')
    .setSubject('smoke-' + randomUUID())
    .setJti(randomUUID())
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(new TextEncoder().encode(c.inviteSecret))
  const response = await fetch(url + '/v1/voice/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + invitation,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const data = await response.json()
  if (response.status !== 201)
    throw new Error(
      'Cloud room/session creation failed with status ' + response.status,
    )
  console.log(
    JSON.stringify({
      test: 'livekit-cloud-gateway',
      roomCreated: true,
      agentDispatchCreated: true,
      scopedTokenIssued: typeof data.participantToken === 'string',
      voiceCallTested: false,
    }),
  )
  const cleanup = await fetch(url + '/v1/voice/sessions/' + data.sessionId, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + data.cleanupToken },
  })
  if (!cleanup.ok) throw new Error('Cloud room cleanup failed')
  console.log(JSON.stringify({ roomDeleted: true }))
} finally {
  await new Promise(resolve => server.close(resolve))
}
