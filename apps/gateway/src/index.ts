import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose'
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  TrackSource,
  ServerError,
} from 'livekit-server-sdk'
import { z } from 'zod'
import {
  signContext,
  requireSecret,
  trustedEndpoint,
  verifyContext,
  type AccessContext,
} from '@packproof/shared-contracts'
import { MetaBudget } from '@packproof/shared-contracts/meta-budget'

export type GatewayConfig = {
  livekitUrl: string
  apiKey: string
  apiSecret: string
  contextSecret: string
  inviteSecret: string
  origins: string[]
  databasePath: string
  maxSessions: number
  maxSessionSeconds: number
  metaBudget?: { path: string; approvedUsd: number }
  auth?: { issuer: string; audience: string; jwksUrl: string }
}
export interface RoomBackend {
  createRoom(name: string): Promise<void>
  dispatch(name: string, metadata: string): Promise<void>
  deleteRoom(name: string): Promise<void>
}
export class LiveKitRooms implements RoomBackend {
  private rooms: RoomServiceClient
  private agents: AgentDispatchClient
  constructor(c: GatewayConfig) {
    const u = c.livekitUrl.replace(/^wss:/, 'https:')
    this.rooms = new RoomServiceClient(u, c.apiKey, c.apiSecret)
    this.agents = new AgentDispatchClient(u, c.apiKey, c.apiSecret)
  }
  async createRoom(name: string) {
    await this.rooms.createRoom({
      name,
      maxParticipants: 2,
      emptyTimeout: 30,
      departureTimeout: 10,
    })
  }
  async dispatch(name: string, metadata: string) {
    await this.agents.createDispatch(name, 'packproof-voice', { metadata })
  }
  async deleteRoom(name: string) {
    try {
      await this.rooms.deleteRoom(name)
    } catch (error) {
      // The worker may already have ended the room before the client/reaper.
      if (
        error instanceof ServerError &&
        error.code === 'not_found' &&
        error.status === 404
      )
        return
      throw error
    }
  }
}
export function configFromEnv(e: NodeJS.ProcessEnv): GatewayConfig {
  const livekitUrl = e.LIVEKIT_URL ?? ''
  if (!/^wss:\/\/[^/]+\.livekit\.cloud$/.test(livekitUrl))
    throw new Error('LiveKit Cloud WSS URL required')
  const auth = e.VOICE_SESSION_AUTH_CONFIG
    ? z
        .object({
          issuer: z.string().min(1),
          audience: z.string().min(1),
          jwksUrl: z.url(),
        })
        .strict()
        .parse(JSON.parse(e.VOICE_SESSION_AUTH_CONFIG))
    : undefined
  if (auth) trustedEndpoint(auth.jwksUrl)
  if (!e.LIVEKIT_API_KEY || !e.LIVEKIT_API_SECRET)
    throw new Error('LiveKit credentials required')
  if (
    e.META_LIVE_ENABLED === 'true' &&
    (!e.META_BUDGET_PATH || !(Number(e.META_TEST_BUDGET_USD) > 0))
  )
    throw new Error(
      'Live voice requires the shared approved Meta budget ledger',
    )
  const origins = (e.VOICE_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)
  if (
    !origins.length ||
    origins.some(o => o === '*' || new URL(o).origin !== o)
  )
    throw new Error('Exact CORS origins required')
  return {
    livekitUrl,
    apiKey: e.LIVEKIT_API_KEY,
    apiSecret: e.LIVEKIT_API_SECRET,
    contextSecret: requireSecret(
      e.VOICE_CONTEXT_SECRET,
      'VOICE_CONTEXT_SECRET',
    ),
    inviteSecret: requireSecret(e.VOICE_INVITE_SECRET, 'VOICE_INVITE_SECRET'),
    origins,
    databasePath: e.GATEWAY_STATE_PATH ?? '.runtime/gateway.sqlite',
    maxSessions: 3,
    maxSessionSeconds: 300,
    ...(e.META_LIVE_ENABLED === 'true'
      ? {
          metaBudget: {
            path: e.META_BUDGET_PATH!,
            approvedUsd: Number(e.META_TEST_BUDGET_USD),
          },
        }
      : {}),
    auth,
  }
}
function hash(s: string) {
  return createHash('sha256').update(s).digest('hex')
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'request_denied',
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}
async function body(req: IncomingMessage): Promise<unknown> {
  let data = ''
  for await (const chunk of req) {
    data += chunk
    if (Buffer.byteLength(data) > 2048)
      throw new HttpError(413, 'Request too large')
  }
  return data ? JSON.parse(data) : {}
}
export function createGateway(
  config: GatewayConfig,
  backend: RoomBackend = new LiveKitRooms(config),
) {
  mkdirSync(dirname(config.databasePath), { recursive: true })
  const db = new DatabaseSync(config.databasePath)
  const budget = config.metaBudget
    ? new MetaBudget(config.metaBudget.path, config.metaBudget.approvedUsd)
    : undefined
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,room TEXT NOT NULL,subject TEXT NOT NULL,ip TEXT NOT NULL,expires INTEGER NOT NULL,cleanup TEXT NOT NULL); CREATE TABLE IF NOT EXISTS used_tokens(jti TEXT PRIMARY KEY,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset INTEGER NOT NULL);`,
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS budget_claims(session_id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL UNIQUE,claimed INTEGER NOT NULL DEFAULT 0);',
  )
  const jwks = config.auth
    ? createRemoteJWKSet(new URL(config.auth.jwksUrl), {
        timeoutDuration: 5000,
        cooldownDuration: 30000,
      })
    : undefined
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(JSON.stringify(value))
  }
  async function authorize(token: string): Promise<{
    payload: JWTPayload
    access: 'public' | 'authenticated'
    scopes: AccessContext['scopes']
  }> {
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(config.inviteSecret),
        {
          algorithms: ['HS256'],
          issuer: 'packproof-voice-invite',
          audience: 'packproof-voice-gateway',
        },
      )
      return { payload, access: 'public', scopes: ['verification:public'] }
    } catch {
      if (!config.auth || !jwks)
        throw new HttpError(
          401,
          'Valid voice invitation or PackProof assertion required',
        )
    }
    try {
      const { payload } = await jwtVerify(token, jwks!, {
        algorithms: ['RS256', 'ES256'],
        issuer: config.auth!.issuer,
        audience: config.auth!.audience,
      })
      const scope = z
        .array(z.enum(['verification:public', 'verification:private']))
        .parse(payload.voice_scopes)
      if (!scope.includes('verification:public')) throw new Error()
      return { payload, access: 'authenticated', scopes: scope }
    } catch {
      throw new HttpError(401, 'Invalid or expired PackProof assertion')
    }
  }
  function rate(key: string, limit: number, windowSeconds = 3600) {
    const now = Math.floor(Date.now() / 1000)
    const old = db
      .prepare('SELECT count,reset FROM attempts WHERE key=?')
      .get(key) as { count: number; reset: number } | undefined
    if (old && old.reset > now && old.count >= limit)
      throw new HttpError(
        429,
        'Voice session limit reached',
        'rate_limited',
        Math.max(1, old.reset - now),
      )
    db.prepare(
      'INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset=excluded.reset',
    ).run(
      key,
      old && old.reset > now ? old.count + 1 : 1,
      old && old.reset > now ? old.reset : now + windowSeconds,
    )
  }
  function releaseUnclaimed(sessionId: string) {
    if (!budget) return
    // Fence first: a concurrent or delayed worker can never redeem a refunded lease.
    db.prepare(
      'UPDATE budget_claims SET claimed=-1 WHERE session_id=? AND claimed=0',
    ).run(sessionId)
    const row = db
      .prepare(
        'SELECT reservation_id FROM budget_claims WHERE session_id=? AND claimed=-1',
      )
      .get(sessionId)
    if (row) budget.releaseUnspent(row.reservation_id as string)
  }
  async function reap() {
    const now = Math.floor(Date.now() / 1000)
    const expired = db
      .prepare('SELECT id,room FROM sessions WHERE expires<=?')
      .all(now) as { id: string; room: string }[]
    for (const s of expired) {
      try {
        releaseUnclaimed(s.id)
        await backend.deleteRoom(s.room)
        db.prepare('DELETE FROM sessions WHERE id=?').run(s.id)
      } catch {
        /* retain the cleanup lease for the next retry */
      }
    }
    db.prepare('DELETE FROM used_tokens WHERE expires<=?').run(now)
    db.prepare('DELETE FROM attempts WHERE reset<=?').run(now)
  }
  // Recover holds from prior browser failures and crashes, without refunding a
  // single reservation that an agent actually claimed.
  for (const row of db
    .prepare(
      'SELECT session_id FROM budget_claims WHERE claimed=-1 OR (claimed=0 AND session_id NOT IN (SELECT id FROM sessions))',
    )
    .all())
    releaseUnclaimed(row.session_id as string)
  const timer = setInterval(() => void reap().catch(() => {}), 10000)
  timer.unref()
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin
    if (origin && !config.origins.includes(origin))
      return reply(res, 403, { error: 'Origin not allowed' })
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type',
      )
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After')
      res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === '/healthz' && req.method === 'GET')
      return reply(res, 200, { status: 'ok' })
    try {
      const token = req.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1]
      const internalClaim =
        req.method === 'POST' && req.url === '/v1/voice/budget/claim'
      if (!token || token.length > (internalClaim ? 24000 : 12000))
        throw new HttpError(401, 'Bearer authorization required')
      if (internalClaim) {
        if (!budget)
          throw new HttpError(403, 'Meta budget admission is disabled')
        z.object({})
          .strict()
          .parse(await body(req))
        const verified = await jwtVerify(
          token,
          new TextEncoder().encode(config.contextSecret),
          {
            algorithms: ['HS256'],
            issuer: 'packproof-voice-gateway',
            audience: 'packproof-voice',
          },
        ).catch(() => {
          throw new HttpError(401, 'Invalid agent context')
        })
        const room = verified.payload.room
        if (typeof room !== 'string')
          throw new HttpError(401, 'Invalid room binding')
        const context = await verifyContext(token, config.contextSecret, room)
        const changed = db
          .prepare(
            'UPDATE budget_claims SET claimed=1 WHERE session_id=? AND reservation_id=? AND claimed=0 AND session_id IN (SELECT id FROM sessions WHERE room=? AND expires>?)',
          )
          .run(
            context.sessionId,
            context.budgetReservationId ?? '',
            room,
            Math.floor(Date.now() / 1000),
          ).changes
        if (changed !== 1)
          throw new HttpError(
            403,
            'Meta budget admission denied or already claimed',
          )
        return reply(res, 200, { admitted: true })
      }
      const deletion = req.url?.match(
        /^\/v1\/voice\/sessions\/([0-9a-f-]{36})$/,
      )
      if (deletion && req.method === 'DELETE') {
        const row = db
          .prepare('SELECT room,cleanup FROM sessions WHERE id=?')
          .get(deletion[1]!) as { room: string; cleanup: string } | undefined
        if (
          !row ||
          !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.cleanup))
        )
          throw new HttpError(403, 'Session cleanup denied')
        releaseUnclaimed(deletion[1]!)
        await backend.deleteRoom(row.room)
        db.prepare('DELETE FROM sessions WHERE id=?').run(deletion[1]!)
        return reply(res, 200, { ended: true })
      }
      if (req.method !== 'POST' || req.url !== '/v1/voice/sessions')
        throw new HttpError(404, 'Not found')
      const ip = hash(req.socket.remoteAddress ?? 'unknown')
      rate('attempt:' + ip, 30, 60)
      z.object({})
        .strict()
        .parse(await body(req)) // no client identity, room, agent or role accepted
      const { payload, access, scopes } = await authorize(token)
      const now = Math.floor(Date.now() / 1000)
      if (
        !payload.sub ||
        payload.sub.length > 128 ||
        !payload.jti ||
        payload.jti.length > 128 ||
        !payload.exp ||
        payload.exp > now + 600
      )
        throw new HttpError(
          401,
          'Short-lived assertion with subject and nonce required',
        )
      const expires = Math.min(payload.exp, now + config.maxSessionSeconds)
      if (expires - now < 20)
        throw new HttpError(401, 'Assertion expires too soon')
      const sessionId = randomUUID(),
        room = 'pp-voice-' + sessionId,
        identity = 'caller-' + randomUUID(),
        cleanupToken = randomBytes(32).toString('base64url')
      let budgetReservationId: string | undefined
      const quotaWindows: { key: string; reset: number }[] = []
      db.exec('BEGIN IMMEDIATE')
      try {
        const count = (
          db.prepare('SELECT count(*) as n FROM sessions').get() as {
            n: number
          }
        ).n
        if (count >= config.maxSessions)
          throw new HttpError(
            429,
            'All voice sessions are busy',
            'capacity_busy',
            10,
          )
        if (
          db.prepare('SELECT 1 FROM used_tokens WHERE jti=?').get(payload.jti)
        )
          throw new HttpError(401, 'Assertion already used', 'invitation_used')
        for (const [key, limit, window] of [
          ['ip:' + ip, 10, 3600],
          ['subject:' + hash(payload.sub), 5, 3600],
          ['global-day', 20, 86400],
        ] as const) {
          rate(key, limit, window)
          quotaWindows.push({
            key,
            reset: db
              .prepare('SELECT reset FROM attempts WHERE key=?')
              .get(key)!.reset as number,
          })
        }
        if (budget) {
          try {
            budgetReservationId = budget.reserve(
              'voice-session:' + sessionId,
              2,
            )
          } catch {
            throw new HttpError(
              429,
              'Approved Meta budget is fully reserved',
              'budget_exhausted',
            )
          }
          db.prepare(
            'INSERT INTO budget_claims(session_id,reservation_id) VALUES(?,?)',
          ).run(sessionId, budgetReservationId)
        }
        db.prepare('INSERT INTO used_tokens VALUES(?,?)').run(
          payload.jti,
          payload.exp,
        )
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(
          sessionId,
          room,
          payload.sub,
          ip,
          expires,
          hash(cleanupToken),
        )
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        if (budgetReservationId) budget?.releaseUnspent(budgetReservationId)
        if (error instanceof HttpError) throw error
        throw new HttpError(401, 'Assertion already used')
      }
      try {
        const context: AccessContext = {
          sessionId,
          room,
          identity,
          subject: payload.sub,
          access,
          scopes,
          expiresAt: expires,
          ...(budgetReservationId ? { budgetReservationId } : {}),
          ...(access === 'authenticated' ? { assertion: token } : {}),
        }
        await backend.createRoom(room)
        await backend.dispatch(
          room,
          await signContext(context, config.contextSecret),
        )
        const at = new AccessToken(config.apiKey, config.apiSecret, {
          identity,
          // The token must remain valid during SDK recovery within this lease.
          ttl: Math.min(config.maxSessionSeconds, expires - now),
        })
        at.addGrant({
          roomJoin: true,
          room,
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: true,
          canUpdateOwnMetadata: false,
        })
        return reply(res, 201, {
          serverUrl: config.livekitUrl,
          participantToken: await at.toJwt(),
          sessionId,
          expiresAt: expires,
          cleanupToken,
        })
      } catch (error) {
        releaseUnclaimed(sessionId)
        // No client token was issued. Undo quota/nonce changes for safe retry.
        for (const q of quotaWindows)
          db.prepare(
            'UPDATE attempts SET count=MAX(0,count-1) WHERE key=? AND reset=?',
          ).run(q.key, q.reset)
        db.prepare('DELETE FROM used_tokens WHERE jti=?').run(payload.jti)
        try {
          await backend.deleteRoom(room)
          db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId)
        } catch {
          /* retain durable cleanup lease */
        }
        if (error instanceof HttpError) throw error
        throw new HttpError(503, 'Voice service unavailable')
      }
    } catch (error) {
      if (error instanceof HttpError && error.retryAfterSeconds)
        res.setHeader('Retry-After', String(error.retryAfterSeconds))
      return reply(
        res,
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 503,
        {
          error:
            error instanceof HttpError ? error.message : 'Request unavailable',
          code: error instanceof HttpError ? error.code : 'request_unavailable',
          ...(error instanceof HttpError && error.retryAfterSeconds
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        },
      )
    }
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  server.on('close', () => {
    clearInterval(timer)
    db.close()
    budget?.close()
  })
  return { server, reap }
}
