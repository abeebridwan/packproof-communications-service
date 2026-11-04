import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnv } from 'node:util'
import {
  configureLocalEnvironment,
  initializeLocalSecrets,
  reportEnvironment,
  cloudAgentValues,
  exportAgentEnvironment,
  publicSpeechEndpoint,
} from '../scripts/environment.mjs'
const secrets = [
  'VOICE_CONTEXT_SECRET',
  'VOICE_INVITE_SECRET',
  'KOKORO_SERVICE_TOKEN',
  'RADIO_CONTROL_TOKEN',
  'ICECAST_SOURCE_PASSWORD',
  'ICECAST_ADMIN_PASSWORD',
]
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'packproof-env-'))
  writeFileSync(
    join(root, '.env.example'),
    '# Local settings\nLIVEKIT_URL=\nLIVEKIT_API_KEY=\nLIVEKIT_API_SECRET=\nMODEL_API_KEY=\nMETA_LIVE_ENABLED=false\nPACKPROOF_MODE=fixtures\nALLOW_LOCAL_SERVICES=false\n' +
      secrets.map(s => s + '=').join('\n') +
      '\nKOKORO_BASE_URL=\n',
  )
  return root
}
function validCloud() {
  return {
    MODEL_API_KEY: 'test-provider-key',
    VOICE_CONTEXT_SECRET: 'c'.repeat(43),
    KOKORO_SERVICE_TOKEN: 't'.repeat(43),
    KOKORO_BASE_URL: 'https://speech.packproof.dev/v1',
    META_LIVE_ENABLED: 'true',
    PACKPROOF_MODE: 'fixtures',
  }
}
describe('environment setup and Cloud secret isolation', () => {
  it('fills generated local settings once, preserves provider keys, keeps paid requests disabled', () => {
    const root = fixture()
    try {
      writeFileSync(
        join(root, '.env.local'),
        '# Keep this comment\nLIVEKIT_URL=wss://configured.livekit.cloud\nLIVEKIT_API_KEY=existing-livekit-key\nLIVEKIT_API_SECRET=existing-livekit-secret\nMODEL_API_KEY=existing-meta-key\nMETA_LIVE_ENABLED=false\nALLOW_LOCAL_SERVICES=false\nKOKORO_BASE_URL=\n',
      )
      configureLocalEnvironment(root)
      const before = readFileSync(join(root, '.env.local'), 'utf8')
      const values = parseEnv(before),
        generated = parseEnv(
          readFileSync(join(root, '.runtime/local.env'), 'utf8'),
        )
      expect(values.MODEL_API_KEY).toBe('existing-meta-key')
      expect(values.LIVEKIT_API_SECRET).toBe('existing-livekit-secret')
      expect(values.META_LIVE_ENABLED).toBe('false')
      expect(values.ALLOW_LOCAL_SERVICES).toBe('true')
      expect(values.KOKORO_BASE_URL).toBe('http://127.0.0.1:8880/v1')
      expect(before).toContain('# Keep this comment')
      for (const name of secrets) expect(values[name]).toBe(generated[name])
      expect(configureLocalEnvironment(root)).toEqual([])
      expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(before)
      expect(statSync(join(root, '.env.local')).mode & 0o777).toBe(0o600)
      const report = reportEnvironment(root)
      expect(report.localReady).toBe(true)
      expect(report.cloud.ready).toBe(false)
      expect(JSON.stringify(report)).not.toContain('existing-meta-key')
      expect(JSON.stringify(report)).not.toContain(
        generated.VOICE_CONTEXT_SECRET,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('preserves explicitly configured shared secrets and reports local-stack mismatches', () => {
    const root = fixture()
    try {
      initializeLocalSecrets(root)
      writeFileSync(
        join(root, '.env.local'),
        'VOICE_CONTEXT_SECRET=' +
          'x'.repeat(43) +
          '\nKOKORO_BASE_URL=https://speech.packproof.dev/v1\nALLOW_LOCAL_SERVICES=false\n',
      )
      configureLocalEnvironment(root)
      const values = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'))
      expect(values.VOICE_CONTEXT_SECRET).toBe('x'.repeat(43))
      expect(values.KOKORO_BASE_URL).toBe('https://speech.packproof.dev/v1')
      expect(values.ALLOW_LOCAL_SERVICES).toBe('false')
      expect(reportEnvironment(root).localSecretMismatches).toContain(
        'VOICE_CONTEXT_SECRET',
      )
      expect(() => initializeLocalSecrets(root)).toThrow(
        'refusing to overwrite',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('exports only external worker settings and omits injected LiveKit, gateway, browser and telephone credentials', () => {
    const root = fixture()
    try {
      const env = {
        ...validCloud(),
        LIVEKIT_URL: 'wss://injected.livekit.cloud',
        LIVEKIT_API_KEY: 'local-key',
        LIVEKIT_API_SECRET: 'local-secret',
        VOICE_INVITE_SECRET: 'gateway-only',
        RADIO_CONTROL_TOKEN: 'radio-only',
        ICECAST_ADMIN_PASSWORD: 'icecast-only',
        VITE_RADIO_STREAM_URL: 'browser-only',
        SIP_AUTH_USERNAME: 'provider-user',
        SIP_AUTH_PASSWORD: 'provider-secret',
        PACKPROOF_API_TOKEN: 'not-needed-in-fixtures',
      }
      writeFileSync(
        join(root, '.env.local'),
        Object.entries(env)
          .map(([n, v]) => `${n}=${v}`)
          .join('\n'),
      )
      const names = exportAgentEnvironment(root)
      const text = readFileSync(join(root, '.env.agent'), 'utf8'),
        exported = parseEnv(text)
      expect(exported.MODEL_API_KEY).toBe(env.MODEL_API_KEY)
      expect(exported.ALLOW_LOCAL_SERVICES).toBe('false')
      for (const n of [
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'LIVEKIT_URL',
        'VOICE_INVITE_SECRET',
        'SIP_AUTH_PASSWORD',
        'VITE_RADIO_STREAM_URL',
        'PACKPROOF_API_TOKEN',
      ]) {
        expect(names).not.toContain(n)
        expect(exported).not.toHaveProperty(n)
      }
      expect(statSync(join(root, '.env.agent')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.each([
    'http://127.0.0.1:8880/v1',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://tts-proxy/v1',
    'https://speech.invalid/v1',
    'https://user:password@speech.packproof.dev/v1',
    'https://speech.packproof.dev',
  ])('blocks a Cloud export for %s', url => {
    expect(
      cloudAgentValues({ ...validCloud(), KOKORO_BASE_URL: url }).ready,
    ).toBe(false)
    expect(publicSpeechEndpoint(url)).toBe(false)
  })
  it('does not write a deployment secret file before endpoint and usage approval requirements are met', () => {
    const root = fixture()
    try {
      configureLocalEnvironment(root)
      expect(() => exportAgentEnvironment(root)).toThrow('META_LIVE_ENABLED')
      expect(existsSync(join(root, '.env.agent'))).toBe(false)
      expect(
        cloudAgentValues({ ...validCloud(), PACKPROOF_MODE: 'http' }).problems,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('PACKPROOF_API_TOKEN'),
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
