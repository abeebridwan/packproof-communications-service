import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  SignJWT,
  decodeJwt,
  generateKeyPair,
  exportJWK,
} from '../apps/gateway/node_modules/jose/dist/webapi/index.js'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetaBudget } from '../packages/shared-contracts/src/meta-budget.js'
import {
  createGateway,
  configFromEnv,
  LiveKitRooms,
  type GatewayConfig,
} from '../apps/gateway/src/index.js'
import {
  RoomServiceClient,
  ServerError,
} from '../apps/gateway/node_modules/livekit-server-sdk/dist/index.js'
const config: GatewayConfig = {
  livekitUrl: 'wss://test.livekit.cloud',
  apiKey: 'test-api-key',
  apiSecret: 'test-secret',
  contextSecret: 'c'.repeat(32),
  inviteSecret: 'i'.repeat(32),
  origins: ['https://packproof.example'],
  databasePath: ':memory:',
  maxSessions: 3,
  maxSessionSeconds: 300,
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanups.splice(0)) await f()
})
async function fixture(overrides: Partial<GatewayConfig> = {}) {
  const backend = {
    createRoom: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {}),
    deleteRoom: vi.fn(async () => {}),
  }
  const g = createGateway({ ...config, ...overrides }, backend)
  g.server.listen(0, '127.0.0.1')
  await once(g.server, 'listening')
  const port = (g.server.address() as { port: number }).port
  cleanups.push(
    () => new Promise<void>(resolve => g.server.close(() => resolve())),
  )
  return { ...g, backend, url: `http://127.0.0.1:${port}` }
}
async function invite(
  options: {
    secret?: string
    expired?: boolean
    extra?: Record<string, unknown>
    jti?: string
  } = {},
) {
  return new SignJWT(options.extra ?? {})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('packproof-voice-invite')
    .setAudience('packproof-voice-gateway')
    .setSubject('anonymous-demo')
    .setJti(options.jti ?? randomUUID())
    .setExpirationTime(options.expired ? '0s' : '5m')
    .setIssuedAt()
    .sign(new TextEncoder().encode(options.secret ?? config.inviteSecret))
}
const request = (
  url: string,
  token?: string,
  body: unknown = {},
  origin = 'https://packproof.example',
) =>
  fetch(url + '/v1/voice/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
describe('gateway authentication, isolation and cleanup', () => {
  it('treats an already-ended LiveKit room as cleaned but retains genuine backend failures', async () => {
    const deletion = vi.spyOn(RoomServiceClient.prototype, 'deleteRoom')
    const backend = new LiveKitRooms(config)
    try {
      deletion.mockRejectedValueOnce(
        new ServerError('not_found', 'room already ended', 404, 'not_found'),
      )
      await expect(
        backend.deleteRoom('owned-ended-room'),
      ).resolves.toBeUndefined()
      deletion.mockRejectedValueOnce(
        new ServerError('unavailable', 'retry required', 503, 'unavailable'),
      )
      await expect(backend.deleteRoom('owned-room')).rejects.toThrow(
        'retry required',
      )
    } finally {
      deletion.mockRestore()
    }
  })
  it('admits a reserved voice budget once and rejects public invitations and replay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-voice-budget-'))
    const { url, backend } = await fixture({
      metaBudget: { path: join(root, 'budget.sqlite'), approvedUsd: 4 },
    })
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
    expect((await request(url, await invite())).status).toBe(201)
    const metadata = backend.dispatch.mock.calls[0]![1]
    const claim = (token: string) =>
      fetch(url + '/v1/voice/budget/claim', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
    expect((await claim(await invite())).status).toBe(401)
    expect((await claim(metadata.slice(0, -8) + 'forged00')).status).toBe(401)
    expect((await claim(metadata)).status).toBe(200)
    expect((await claim(metadata)).status).toBe(403)
    const ledger = new MetaBudget(join(root, 'budget.sqlite'), 4)
    expect(ledger.summary().reservedOrUncertainUsd).toBe(2)
    ledger.close()
  })
  it('shares prior test spending, persists voice reservations and refuses sessions before dispatch when exhausted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-voice-total-'))
    const path = join(root, 'budget.sqlite')
    const seed = new MetaBudget(path, 4)
    const id = seed.reserve('earlier-provider-test', 0.05)
    seed.settle(id, { success: true, costUsd: 0.01 })
    seed.close()
    const { url, backend } = await fixture({
      metaBudget: { path, approvedUsd: 4 },
    })
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }))
    expect((await request(url, await invite())).status).toBe(201)
    const response = await request(url, await invite())
    expect(response.status).toBe(429)
    expect(backend.dispatch).toHaveBeenCalledOnce()
    const ledger = new MetaBudget(path, 4)
    expect(ledger.summary().conservativeRemainingUsd).toBe(1.99)
    ledger.close()
  })
  it('rejects unauthenticated, forged and expired token requests', async () => {
    const { url, backend } = await fixture()
    for (const token of [
      undefined,
      await invite({ secret: 'a'.repeat(32) }),
      await invite({ expired: true }),
    ])
      expect((await request(url, token)).status).toBe(401)
    expect(backend.createRoom).not.toHaveBeenCalled()
  })
  it('rejects client identities, roles, room names and unapproved origins', async () => {
    const { url } = await fixture(),
      token = await invite()
    for (const body of [
      { userId: 'victim' },
      { role: 'manufacturer' },
      { room: 'another-session' },
    ])
      expect((await request(url, token, body)).status).toBe(400)
    expect(
      (await request(url, token, {}, 'https://attacker.invalid')).status,
    ).toBe(403)
  })
  it('creates an isolated public session with bounded grants and server-side dispatch', async () => {
    const { url, backend } = await fixture()
    const response = await request(
      url,
      await invite({
        extra: {
          userId: 'victim',
          voice_scopes: ['verification:private'],
          role: 'manufacturer',
        },
      }),
    )
    expect(response.status).toBe(201)
    const value = await response.json()
    const jwt = decodeJwt(value.participantToken)
    expect(jwt.video).toMatchObject({
      roomJoin: true,
      canUpdateOwnMetadata: false,
    })
    expect(jwt.exp! - jwt.nbf!).toBeLessThanOrEqual(300)
    expect(jwt.exp!).toBeLessThanOrEqual(value.expiresAt)
    expect(jwt).not.toHaveProperty('apiSecret')
    expect(value).not.toHaveProperty('subject')
    expect(value).not.toHaveProperty('assertion')
    expect(backend.dispatch).toHaveBeenCalledOnce()
    const ctx = decodeJwt(backend.dispatch.mock.calls[0]![1])
    expect(ctx.access).toBe('public')
    expect(ctx.scopes).toEqual(['verification:public'])
    expect(ctx).not.toHaveProperty('assertion')
  })
  it('consumes assertion nonce once, uses distinct rooms, denies cross-session cleanup', async () => {
    const { url, backend } = await fixture()
    const token = await invite()
    const a = await (await request(url, token)).json()
    expect((await request(url, token)).status).toBe(401)
    const b = await (await request(url, await invite())).json()
    expect(decodeJwt(a.participantToken).video).not.toEqual(
      decodeJwt(b.participantToken).video,
    )
    expect(
      (
        await fetch(url + '/v1/voice/sessions/' + b.sessionId, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${a.cleanupToken}` },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(url + '/v1/voice/sessions/' + a.sessionId, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${a.cleanupToken}` },
        })
      ).status,
    ).toBe(200)
    expect(backend.deleteRoom).toHaveBeenCalled()
  })
  it('enforces concurrent session capacity', async () => {
    const { url } = await fixture()
    for (let i = 0; i < 3; i++)
      expect((await request(url, await invite())).status).toBe(201)
    expect((await request(url, await invite())).status).toBe(429)
  })
  it('cleans a room after a dispatch failure and never issues its token', async () => {
    const { url, backend } = await fixture()
    backend.dispatch.mockRejectedValueOnce(
      new Error('upstream contains private details'),
    )
    const response = await request(url, await invite())
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private details')
    expect(backend.deleteRoom).toHaveBeenCalledOnce()
  })
  it('requires explicit trusted JWT integration and Cloud URL configuration', () => {
    expect(() => configFromEnv({})).toThrow()
    expect(() =>
      configFromEnv({
        LIVEKIT_URL: 'wss://test.livekit.cloud',
        LIVEKIT_API_KEY: 'x',
        LIVEKIT_API_SECRET: 'x',
        VOICE_CONTEXT_SECRET: 's'.repeat(32),
        VOICE_INVITE_SECRET: 't'.repeat(32),
        VOICE_ALLOWED_ORIGINS: '*',
      }),
    ).toThrow()
  })
})

it('validates a trusted asymmetric PackProof assertion and delegates only its signed scopes', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'packproof-test'
  const keys = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  keys.listen(0, '127.0.0.1')
  await once(keys, 'listening')
  cleanups.push(() => new Promise<void>(resolve => keys.close(() => resolve())))
  const jwksUrl =
    'http://127.0.0.1:' + (keys.address() as { port: number }).port + '/jwks'
  const { url, backend } = await fixture({
    auth: {
      issuer: 'https://packproof.example',
      audience: 'packproof-voice-gateway',
      jwksUrl,
    },
  })
  const assertion = await new SignJWT({
    voice_scopes: ['verification:public', 'verification:private'],
    role: 'regular-user',
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'packproof-test' })
    .setIssuer('https://packproof.example')
    .setAudience('packproof-voice-gateway')
    .setSubject('trusted-subject')
    .setJti(randomUUID())
    .setExpirationTime('5m')
    .sign(privateKey)
  expect((await request(url, assertion)).status).toBe(201)
  const context = decodeJwt(backend.dispatch.mock.calls[0]![1])
  expect(context.subject).toBe('trusted-subject')
  expect(context.access).toBe('authenticated')
  expect(context.scopes).toEqual([
    'verification:public',
    'verification:private',
  ])
  expect(context.assertion).toBe(assertion)
  expect(context).not.toHaveProperty('role')
})
