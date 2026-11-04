import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

export const localSecretNames = [
  'VOICE_CONTEXT_SECRET',
  'VOICE_INVITE_SECRET',
  'KOKORO_SERVICE_TOKEN',
  'RADIO_CONTROL_TOKEN',
  'ICECAST_SOURCE_PASSWORD',
  'ICECAST_ADMIN_PASSWORD',
]
export function initializeLocalSecrets(root) {
  const path = join(root, '.runtime/local.env')
  if (existsSync(path))
    throw new Error('Local secrets already exist; refusing to overwrite')
  mkdirSync(join(root, '.runtime/radio/media'), { recursive: true })
  mkdirSync(join(root, '.runtime/gateway'), { recursive: true })
  writeFileSync(
    path,
    localSecretNames
      .map(name => `${name}=${randomBytes(32).toString('base64url')}`)
      .join('\n') + '\nRADIO_MODE=fixtures\nMETA_LIVE_ENABLED=false\n',
    { mode: 0o600 },
  )
  return path
}
function readLocal(root) {
  const path = join(root, '.env.local')
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}
}
export function configureLocalEnvironment(root) {
  const secretPath = join(root, '.runtime/local.env')
  if (!existsSync(secretPath)) initializeLocalSecrets(root)
  const local = parseEnv(readFileSync(secretPath, 'utf8'))
  const path = join(root, '.env.local')
  let text = readFileSync(
    existsSync(path) ? path : join(root, '.env.example'),
    'utf8',
  )
  const values = parseEnv(text),
    changed = []
  function set(name, value, replace = false) {
    if (values[name] && !replace) return
    const pattern = new RegExp(`^(?:export\\s+)?${name}\\s*=.*$`, 'gm')
    if ([...text.matchAll(pattern)].length > 1)
      throw new Error(`Remove duplicate ${name} assignments before configuring`)
    text = pattern.test(text)
      ? text.replace(new RegExp(pattern.source, 'm'), () => `${name}=${value}`)
      : text.replace(/\n?$/, '\n') + `${name}=${value}\n`
    values[name] = value
    changed.push(name)
  }
  for (const name of localSecretNames) {
    if (!local[name] || local[name].length < 32)
      throw new Error(
        `Missing generated ${name}; preserve or repair the existing local secret file`,
      )
    set(name, local[name])
  }
  if (!values.KOKORO_BASE_URL) {
    set('KOKORO_BASE_URL', 'http://127.0.0.1:8880/v1')
    set('ALLOW_LOCAL_SERVICES', 'true', true)
  }
  for (const [name, value] of Object.entries({
    PACKPROOF_MODE: 'fixtures',
    RADIO_MODE: 'fixtures',
    META_LIVE_ENABLED: 'false',
    VOICE_ALLOWED_ORIGINS:
      'http://localhost:5173,https://packproof-p0.vercel.app',
    VITE_VOICE_GATEWAY_URL: 'http://localhost:8080',
    VITE_PACKPROOF_ORIGIN: 'https://packproof-p0.vercel.app',
    VITE_RADIO_STREAM_URL: 'http://127.0.0.1:8000/packproof.mp3',
  }))
    set(name, value)
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
  chmodSync(secretPath, 0o600)
  return changed
}
export function publicSpeechEndpoint(value) {
  try {
    const u = new URL(value),
      host = u.hostname
        .toLowerCase()
        .replace(/\.$/, '')
        .replace(/^\[|\]$/g, '')
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname.replace(/\/$/, '').endsWith('/v1') &&
      host.includes('.') &&
      !isIP(host) &&
      !['localhost', 'example.com', 'example.org', 'example.net'].includes(
        host,
      ) &&
      !/\.(localhost|local|internal|invalid|test|example)$/.test(host)
    )
  } catch {
    return false
  }
}
export function cloudAgentValues(env) {
  const problems = []
  for (const name of [
    'MODEL_API_KEY',
    'VOICE_CONTEXT_SECRET',
    'KOKORO_BASE_URL',
    'KOKORO_SERVICE_TOKEN',
  ])
    if (!env[name]) problems.push(`${name} is missing`)
  for (const name of ['VOICE_CONTEXT_SECRET', 'KOKORO_SERVICE_TOKEN'])
    if (env[name] && env[name].length < 32)
      problems.push(`${name} must contain at least 32 characters`)
  if (env.META_LIVE_ENABLED !== 'true')
    problems.push(
      'META_LIVE_ENABLED is disabled; a key alone is not spending approval',
    )
  if (!publicSpeechEndpoint(env.KOKORO_BASE_URL))
    problems.push(
      'KOKORO_BASE_URL needs a protected public HTTPS hostname ending in /v1; local Docker URLs cannot serve a Cloud worker',
    )
  if (!['fixtures', 'http'].includes(env.PACKPROOF_MODE))
    problems.push('PACKPROOF_MODE must be fixtures or http')
  if (env.PACKPROOF_MODE === 'http') {
    for (const name of ['PACKPROOF_API_BASE_URL', 'PACKPROOF_API_TOKEN'])
      if (!env[name])
        problems.push(
          `${name} is awaiting the scoped Terminal 1 API integration`,
        )
    try {
      const u = new URL(env.PACKPROOF_API_BASE_URL)
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error()
    } catch {
      problems.push('PACKPROOF_API_BASE_URL must be HTTPS')
    }
  }
  if (problems.length) return { ready: false, problems, values: {} }
  const names = [
    'MODEL_API_KEY',
    'VOICE_CONTEXT_SECRET',
    'KOKORO_BASE_URL',
    'KOKORO_SERVICE_TOKEN',
    'META_LIVE_ENABLED',
    'PACKPROOF_MODE',
  ]
  if (env.PACKPROOF_MODE === 'http')
    names.push(
      'PACKPROOF_API_BASE_URL',
      'PACKPROOF_API_TOKEN',
      'PACKPROOF_ENDPOINT_PATHS',
    )
  if (env.LIVEKIT_ALLOWED_SIP_TRUNKS) names.push('LIVEKIT_ALLOWED_SIP_TRUNKS')
  return {
    ready: true,
    problems: [],
    values: {
      ...Object.fromEntries(
        names.filter(name => env[name]).map(name => [name, env[name]]),
      ),
      ALLOW_LOCAL_SERVICES: 'false',
    },
  }
}
export function exportAgentEnvironment(root) {
  const result = cloudAgentValues(readLocal(root))
  if (!result.ready) throw new Error(result.problems.join('\n'))
  const lines = Object.entries(result.values).map(([name, value]) => {
    if (/[\r\n]/.test(value))
      throw new Error(`${name} must be a single-line value`)
    if (!value.includes("'")) return `${name}='${value}'`
    if (!value.includes('"')) return `${name}="${value}"`
    throw new Error(
      `${name} cannot be safely serialized; use the protected secrets dashboard`,
    )
  })
  const text = lines.join('\n') + '\n',
    roundTrip = parseEnv(text)
  if (
    Object.entries(result.values).some(
      ([name, value]) => roundTrip[name] !== value,
    )
  )
    throw new Error('Secret-file serialization failed validation')
  const path = join(root, '.env.agent')
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
  return Object.keys(result.values)
}
export function reportEnvironment(root) {
  const env = readLocal(root)
  const required = [
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'MODEL_API_KEY',
    ...localSecretNames,
    'KOKORO_BASE_URL',
  ]
  const missing = required.filter(name => !env[name])
  const mismatched = []
  const path = join(root, '.runtime/local.env')
  if (existsSync(path)) {
    const stack = parseEnv(readFileSync(path, 'utf8'))
    for (const name of localSecretNames)
      if (env[name] && stack[name] && env[name] !== stack[name])
        mismatched.push(name)
  }
  const cloud = cloudAgentValues(env)
  return {
    localReady: missing.length === 0 && mismatched.length === 0,
    missing,
    localSecretMismatches: mismatched,
    metaInferenceEnabled: env.META_LIVE_ENABLED === 'true',
    providerAccessTested: false,
    cloud: { ready: cloud.ready, problems: cloud.problems },
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const action = process.argv[2] ?? 'check',
      root = process.cwd()
    if (action === 'local')
      console.log(
        JSON.stringify({
          updatedVariables: configureLocalEnvironment(root),
          credentialsPrinted: false,
        }),
      )
    else if (action === 'agent')
      console.log(
        JSON.stringify({
          file: '.env.agent',
          exportedNames: exportAgentEnvironment(root),
          livekitCredentials: 'injected by LiveKit Cloud',
          uploaded: false,
        }),
      )
    else if (action === 'check') {
      const r = reportEnvironment(root)
      // Never print cloud.values: that object deliberately contains actual secrets.
      console.log(
        JSON.stringify(
          {
            localReady: r.localReady,
            missing: r.missing,
            localSecretMismatches: r.localSecretMismatches,
            metaInferenceEnabled: r.metaInferenceEnabled,
            providerAccessTested: false,
            cloudReady: r.cloud.ready,
            cloudBlockers: r.cloud.problems,
          },
          null,
          2,
        ),
      )
      if (!r.localReady || (process.argv.includes('--cloud') && !r.cloud.ready))
        process.exitCode = 1
    } else throw new Error('Choose local, check, or agent')
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Environment setup failed',
    )
    process.exitCode = 1
  }
}
