import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { MetaTestBudget } from './meta-test-budget.mjs'
import {
  MuseScriptClient,
  KokoroClient,
} from '../packages/speech/dist/index.js'
import {
  initializeLogger,
  stt,
} from '../apps/voice-agent/node_modules/@livekit/agents/dist/index.js'
import { STT } from '../apps/voice-agent/node_modules/@livekit/agents-plugin-meta/dist/index.js'
import { AudioFrame } from '../apps/voice-agent/node_modules/@livekit/rtc-node/dist/index.js'

if (!process.argv.includes('--run-live'))
  throw new Error('Pass --run-live to explicitly run bounded paid Meta tests')
if (!process.env.MODEL_API_KEY) throw new Error('MODEL_API_KEY is required')
const budget = new MetaTestBudget(
  '.runtime/meta-test-budget.sqlite',
  Number(process.env.META_TEST_BUDGET_USD ?? 0),
)
initializeLogger({ pretty: false, level: 'silent' })
const result = {
  testedAt: new Date().toISOString(),
  scope: 'synthetic fixtures only; no real caller or product records',
}
try {
  const reservation = budget.reserve('muse-spark-1.3-smoke')
  let usage, providerStatus, finishReason
  const draft = await new MuseScriptClient({
    enabled: true,
    apiKey: process.env.MODEL_API_KEY,
    maxRequests: 1,
    fetch: async (url, options) => {
      const response = await fetch(url, options)
      providerStatus = response.status
      try {
        const parsed = await response.clone().json()
        usage = parsed.usage
        finishReason = parsed.choices?.[0]?.finish_reason
      } catch {}
      return response
    },
  }).compose([
    'This is a fixture-only PackProof demonstration.',
    'The recorded evidence does not guarantee that a physical item is genuine.',
  ])
  const cost =
    usage &&
    Number.isFinite(usage.prompt_tokens) &&
    Number.isFinite(usage.completion_tokens)
      ? (usage.prompt_tokens * 1.25 + usage.completion_tokens * 4.25) /
        1_000_000
      : undefined
  budget.settle(reservation, {
    success: draft.source === 'muse-spark-1.3',
    costUsd: cost,
  })
  result.spark = {
    live: draft.source === 'muse-spark-1.3',
    finishReason,
    providerStatus,
    source: draft.source,
    fallbackReason: draft.reason,
    usage: usage
      ? {
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens,
        }
      : undefined,
    estimatedCostUsd: cost,
  }
  console.log(JSON.stringify({ test: 'live-muse-spark', ...result.spark }))
  if (process.argv.includes('--spark-only')) {
    result.transcribe = {
      tested: false,
      reason: 'Spark-only test; earlier STT artifact preserved',
    }
  } else if (providerStatus === 401) {
    result.transcribe = {
      tested: false,
      reason: 'Same Meta key was rejected with HTTP 401',
    }
    process.exitCode = 1
  } else {
    const tts = new KokoroClient({
      baseUrl: process.env.KOKORO_BASE_URL,
      token: process.env.KOKORO_SERVICE_TOKEN,
      allowLocal: process.env.ALLOW_LOCAL_SERVICES === 'true',
    })
    const wav = await tts.wav(
      'The product identifier is zero zero seven one eight four two.',
    )
    const pcm = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        'pipe:0',
        '-ac',
        '1',
        '-ar',
        '24000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { input: wav, maxBuffer: 2_000_000 },
    )
    if (pcm.length / (24000 * 2) > 12)
      throw new Error('Synthetic audio exceeds the approved short test length')
    const audio = Buffer.concat([pcm, Buffer.alloc(24000 * 2 * 2)])
    const id = budget.reserve('muse-voice-transcribe-1.0-smoke')
    const provider = new STT({
      apiKey: process.env.MODEL_API_KEY,
      model: 'muse-voice-transcribe-1.0',
      languageBias: ['English'],
      keywords: ['PackProof'],
    })
    const stream = provider.stream({
      language: 'en-US',
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 8000 },
    })
    const finals = []
    let running = true,
      sent = 0,
      usageSeconds = 0,
      timer,
      started = Date.now(),
      failure
    const reader = (async () => {
      for await (const event of stream) {
        if (
          event.type === stt.SpeechEventType.FINAL_TRANSCRIPT &&
          event.alternatives?.[0]?.text
        )
          finals.push(event.alternatives[0].text)
        if (event.recognitionUsage)
          usageSeconds += event.recognitionUsage.audioDuration
      }
    })()
    const writer = (async () => {
      for (let offset = 0; offset < audio.length && running; offset += 960) {
        const bytes = audio.subarray(offset, offset + 960)
        const frame = new Int16Array(480)
        Buffer.from(frame.buffer).set(bytes)
        stream.pushFrame(new AudioFrame(frame, 24000, 1, 480))
        sent += 0.02
        await delay(20)
      }
      if (running) stream.endInput()
    })()
    try {
      await Promise.race([
        Promise.all([reader, writer]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('STT_TEST_TIMEOUT')), 20000)
        }),
      ])
    } catch (error) {
      failure = {
        type: error?.name ?? 'Error',
        statusCode:
          typeof error?.statusCode === 'number' ? error.statusCode : undefined,
        code:
          error?.message === 'STT_TEST_TIMEOUT'
            ? 'timeout'
            : 'provider_rejected_or_unavailable',
      }
    } finally {
      running = false
      clearTimeout(timer)
      stream.close()
      await provider.close()
      await Promise.allSettled([reader, writer])
    }
    const seconds = Math.max(sent, usageSeconds)
    // Keep the full reservation if provider acknowledgement/usage is uncertain.
    const estimated = finals.length
      ? (Math.ceil(seconds) * 0.18) / 3600
      : undefined
    budget.settle(id, { success: finals.length > 0, costUsd: estimated })
    result.transcribe = {
      live: finals.length > 0,
      model: 'muse-voice-transcribe-1.0',
      syntheticTranscript: finals.join(' '),
      audioSecondsSent: Number(sent.toFixed(2)),
      providerUsageSeconds: usageSeconds,
      durationMs: Date.now() - started,
      failure,
      estimatedCostUsd: estimated,
    }
    console.log(
      JSON.stringify({ test: 'live-muse-transcribe', ...result.transcribe }),
    )
    if (!finals.length) process.exitCode = 1
  }
  if (!result.spark.live) process.exitCode = 1
} catch (error) {
  result.error = {
    type: error?.name ?? 'Error',
    code: 'test_failed_or_budget_unavailable',
  }
  console.error(JSON.stringify(result.error))
  process.exitCode = 1
} finally {
  result.budget = budget.summary()
  budget.close()
  mkdirSync('.runtime/artifacts', { recursive: true })
  writeFileSync(
    process.argv.includes('--spark-only')
      ? '.runtime/artifacts/meta-smoke-spark.json'
      : '.runtime/artifacts/meta-smoke.json',
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ testBudget: result.budget }))
}
