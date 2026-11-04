// Deliberately prints a caller-facing, one-use, five-minute invitation. No service secret.
import { SignJWT } from '../apps/gateway/node_modules/jose/dist/webapi/index.js'
import { randomUUID } from 'node:crypto'
if (
  !process.env.VOICE_INVITE_SECRET ||
  process.env.VOICE_INVITE_SECRET.length < 32
)
  throw new Error('VOICE_INVITE_SECRET required')
console.log(
  await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('packproof-voice-invite')
    .setAudience('packproof-voice-gateway')
    .setSubject('demo-' + randomUUID())
    .setJti(randomUUID())
    .setExpirationTime('5m')
    .setIssuedAt()
    .sign(new TextEncoder().encode(process.env.VOICE_INVITE_SECRET)),
)
