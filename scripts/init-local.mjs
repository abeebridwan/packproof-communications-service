import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
mkdirSync('.runtime/gateway', { recursive: true })
mkdirSync('.runtime/radio/media', { recursive: true })
const path = '.runtime/local.env'
if (existsSync(path))
  throw new Error('Local secrets already exist; refusing to overwrite')
const names = [
  'VOICE_CONTEXT_SECRET',
  'VOICE_INVITE_SECRET',
  'KOKORO_SERVICE_TOKEN',
  'RADIO_CONTROL_TOKEN',
  'ICECAST_SOURCE_PASSWORD',
  'ICECAST_ADMIN_PASSWORD',
]
writeFileSync(
  path,
  names.map(n => n + '=' + randomBytes(32).toString('base64url')).join('\n') +
    '\nRADIO_MODE=fixtures\nMETA_LIVE_ENABLED=false\n',
  { mode: 0o600 },
)
console.log(
  'Local-only service secrets written to ignored .runtime/local.env. No live provider credentials added.',
)
