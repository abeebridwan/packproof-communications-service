import { ServerOptions, cli, defineAgent, voice } from '@livekit/agents'
import * as meta from '@livekit/agents-plugin-meta'
import * as openai from '@livekit/agents-plugin-openai'
import * as silero from '@livekit/agents-plugin-silero'
import { RoomServiceClient } from 'livekit-server-sdk'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  verifyContext,
  requireSecret,
  trustedEndpoint,
  type AccessContext,
} from '@packproof/shared-contracts'
import {
  clientFromEnv,
  PackProofVerificationProvider,
} from '@packproof/verification-adapters'
import { KokoroClient } from '@packproof/speech'
import { createPackProofAgent } from './index.js'
import { approvedInboundCall } from './telephony.js'
import OpenAI from 'openai'
import { boundedMetaFetch } from './meta-limits.js'
import { KokoroTTS } from './kokoro.js'

dotenv.config({ path: '.env.local', quiet: true })
export default defineAgent({
  prewarm: async proc => {
    proc.userData.vad = await silero.VAD.load()
  },
  entry: async ctx => {
    if (!process.env.MODEL_API_KEY || process.env.META_LIVE_ENABLED !== 'true')
      throw new Error(
        'Approved live Meta credentials and META_LIVE_ENABLED=true are required for audio sessions',
      )
    const base = trustedEndpoint(
      process.env.KOKORO_BASE_URL ?? '',
      process.env.ALLOW_LOCAL_SERVICES === 'true',
    )
    if (
      process.env.NODE_ENV === 'production' &&
      ['localhost', '127.0.0.1', 'kokoro', 'tts-proxy'].includes(base.hostname)
    )
      throw new Error(
        'Cloud workers require a reachable protected Kokoro HTTPS endpoint',
      )
    const token = process.env.KOKORO_SERVICE_TOKEN
    if (!token) throw new Error('Protected Kokoro credentials required')
    const secret = requireSecret(
      process.env.VOICE_CONTEXT_SECRET,
      'VOICE_CONTEXT_SECRET',
    )
    await ctx.connect()
    let joinTimer: ReturnType<typeof setTimeout>
    const participant = await Promise.race([
      ctx.waitForParticipant(),
      new Promise<never>((_resolve, reject) => {
        joinTimer = setTimeout(() => {
          ctx.shutdown()
          reject(new Error('Caller did not join in time'))
        }, 20000)
      }),
    ]).finally(() => clearTimeout(joinTimer))
    let access: AccessContext
    if (ctx.job.metadata)
      access = await verifyContext(ctx.job.metadata, secret, ctx.room.name!)
    else {
      // SIP attributes are set by LiveKit's SIP service. Caller ID never grants access.
      if (!approvedInboundCall(participant, process.env))
        throw new Error(
          'Authorized gateway dispatch or an approved inbound phone route required',
        )
      access = {
        sessionId: randomUUID(),
        room: ctx.room.name!,
        identity: participant.identity,
        subject: 'anonymous-sip',
        access: 'public',
        scopes: ['verification:public'],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }
    }
    if (participant.identity !== access.identity)
      throw new Error('Caller identity mismatch')
    // A single-use gateway claim prevents worker restarts or duplicate dispatch
    // from spending the same lease twice. SIP admission is not enabled yet.
    if (!access.budgetReservationId || !ctx.job.metadata)
      throw new Error('A gateway-admitted Meta budget reservation is required')
    const gateway = trustedEndpoint(
      process.env.VOICE_GATEWAY_PUBLIC_URL ?? '',
      process.env.ALLOW_LOCAL_SERVICES === 'true',
    )
    const admission = await fetch(new URL('/v1/voice/budget/claim', gateway), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.job.metadata}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!admission.ok) throw new Error('Meta budget admission denied')
    const roomApi = new RoomServiceClient(
      process.env.LIVEKIT_URL!.replace(/^wss:/, 'https:'),
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
    )
    const telemetry = (event: string, details?: Record<string, unknown>) =>
      console.info(
        JSON.stringify({
          service: 'voice-agent',
          sessionId: access.sessionId,
          event,
          ...details,
        }),
      )
    const startedAt = Date.now()
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      // The shutdown callback closes providers before attempting network cleanup.
      ctx.shutdown()
    }
    const model = new openai.LLM({
      client: new OpenAI({
        baseURL: 'https://api.meta.ai/v1',
        apiKey: process.env.MODEL_API_KEY,
        maxRetries: 0,
        fetch: boundedMetaFetch(),
      }),
      baseURL: 'https://api.meta.ai/v1',
      apiKey: process.env.MODEL_API_KEY,
      model: 'muse-spark-1.3',
      maxCompletionTokens: 2048,
      reasoningEffort: 'minimal',
      parallelToolCalls: false,
      store: false,
    })
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as silero.VAD,
      stt: new meta.STT({
        apiKey: process.env.MODEL_API_KEY,
        model: 'muse-voice-transcribe-1.0',
        keywords: ['PackProof', 'ChainProof', 'Inspector'],
        languageBias: ['English'],
      }),
      llm: model,
      tts: new KokoroTTS(
        new KokoroClient({
          baseUrl: base.toString(),
          token,
          allowLocal: process.env.ALLOW_LOCAL_SERVICES === 'true',
        }),
      ),
      maxToolSteps: 3,
      userAwayTimeout: 45,
      transcriptionTimeout: 6000,
      // Measured CPU Kokoro first audio can exceed the SDK's 10s default.
      ttsReadIdleTimeout: 45000,
      connOptions: {
        llmConnOptions: { maxRetry: 0, timeoutMs: 20000 },
        sttConnOptions: { maxRetry: 0, timeoutMs: 10000 },
        ttsConnOptions: { maxRetry: 1, timeoutMs: 30000 },
      },
      turnHandling: {
        turnDetection: 'stt',
        interruption: { mode: 'vad', enabled: true, minDuration: 400 },
        preemptiveGeneration: { enabled: false },
      },
    })
    const { agent, bindSession } = createPackProofAgent({
      provider: new PackProofVerificationProvider(clientFromEnv(process.env)),
      access,
      model,
      telemetry,
      onEnd: stop,
      publish: async result => {
        await ctx.room.localParticipant?.publishData(
          new TextEncoder().encode(JSON.stringify(result)),
          {
            reliable: true,
            topic: 'packproof.verification',
            destination_identities: [access.identity],
          },
        )
      },
    })
    bindSession(session)
    const lifetime = setTimeout(
      stop,
      Math.max(0, Math.min(300000, access.expiresAt * 1000 - Date.now())),
    )
    session.on(voice.AgentSessionEventTypes.UserStateChanged, e => {
      if (e.newState === 'away') stop()
    })
    session.on(voice.AgentSessionEventTypes.Error, event => {
      telemetry('provider_error', { provider: event.error.type })
      // llmNode owns the deterministic spoken fallback; speech-provider failures end the call.
      if (event.error.type !== 'llm_error') stop()
    })
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, e =>
      telemetry('agent_state', { state: e.newState }),
    )
    session.on(voice.AgentSessionEventTypes.UserTranscriptionTimeout, () => {
      telemetry('transcription_timeout')
      void session.say(
        'I could not hear the full identifier. Please repeat it one character at a time.',
      )
    })
    session.on(voice.AgentSessionEventTypes.Close, () => {
      clearTimeout(lifetime)
      telemetry('session_closed', {
        durationSeconds: Math.ceil((Date.now() - startedAt) / 1000),
      })
      stop()
    })
    ctx.addShutdownCallback(async () => {
      clearTimeout(lifetime)
      await session.close()
      await Promise.race([
        roomApi
          .deleteRoom(access.room)
          .catch(() => telemetry('room_cleanup_failed')),
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, 5000)
          t.unref()
        }),
      ])
    })
    await session.start({
      agent,
      room: ctx.room,
      record: false,
      inputOptions: {
        participantIdentity: access.identity,
        closeOnDisconnect: true,
      },
    })
    session.say(
      process.env.PACKPROOF_MODE === 'fixtures'
        ? 'This is a fixture-only PackProof demonstration. Please tell me the product ID.'
        : 'Hello. I can help check PackProof evidence. Please tell me the product ID.',
    )
  },
})
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'packproof-voice',
  }),
)
