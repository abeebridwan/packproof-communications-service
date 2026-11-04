import { it, expect, vi } from 'vitest'
import {
  llm,
  voice,
  initializeLogger,
  DEFAULT_API_CONNECT_OPTIONS,
} from '../apps/voice-agent/node_modules/@livekit/agents/dist/index.js'
import { randomUUID } from 'node:crypto'
import { createPackProofAgent } from '../apps/voice-agent/src/index.js'
import {
  FixtureVerificationClient,
  PackProofVerificationProvider,
} from '../packages/verification-adapters/src/index.js'
initializeLogger({ pretty: false, level: 'silent' })
class ScriptedModel extends llm.LLM {
  constructor(private produce: (context: llm.ChatContext) => llm.ChatChunk[]) {
    super()
  }
  label() {
    return 'scripted-test-model'
  }
  chat(options: Parameters<llm.LLM['chat']>[0]) {
    const chunks = this.produce(options.chatCtx)
    return new (class extends llm.LLMStream {
      async run() {
        for (const chunk of chunks) this.queue.put(chunk)
      }
    })(this, {
      ...options,
      connOptions: options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    })
  }
}
it('drives identifier intake, later confirmation and lookup through the real SDK session', async () => {
  let phase = 0
  const model = new ScriptedModel(context => {
    const last = context.items.at(-1)
    const control = JSON.parse(
      last?.type === 'message' ? (last.textContent ?? '{}') : '{}',
    )
    const call = (name: string, args: unknown): llm.ChatChunk[] => [
      {
        id: randomUUID(),
        delta: {
          role: 'assistant',
          toolCalls: [
            new llm.FunctionCall({
              callId: randomUUID(),
              name,
              args: JSON.stringify(args),
            }),
          ],
        },
      },
    ]
    if (phase++ === 0)
      return call('propose_identifier', {
        itemId: '0071842',
        sourceMessageId: control.latestUserMessageId,
      })
    if (phase === 2)
      return [
        {
          id: randomUUID(),
          delta: { role: 'assistant', content: control.speechCatalogue.at(-1) },
        },
      ]
    if (phase === 3)
      return call('confirm_identifier', {
        sourceMessageId: control.latestUserMessageId,
      })
    return [
      {
        id: randomUUID(),
        delta: {
          role: 'assistant',
          content: control.speechCatalogue.find((s: string) =>
            s.startsWith('This is a fixture-only'),
          ),
        },
      },
    ]
  })
  const session = new voice.AgentSession({
    llm: model,
    turnHandling: { turnDetection: 'manual' },
    userAwayTimeout: null,
  })
  const client = new FixtureVerificationClient()
  const lookup = vi.spyOn(client, 'lookup')
  const instance = createPackProofAgent({
    provider: new PackProofVerificationProvider(client),
    access: {
      sessionId: randomUUID(),
      room: 'sdk-test',
      identity: 'caller',
      subject: 'demo',
      access: 'public',
      scopes: ['verification:public'],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    },
    model,
  })
  instance.bindSession(session)
  try {
    await session.start({ agent: instance.agent, record: false })
    const a = await session
      .run({ userInput: 'The code is zero zero seven one eight four two.' })
      .wait()
    a.expect.nextEvent().isFunctionCall({ name: 'propose_identifier' })
    a.expect.nextEvent().isFunctionCallOutput()
    a.expect.nextEvent().isMessage({ role: 'assistant' })
    a.expect.noMoreEvents()
    expect(instance.state.pending?.delivered).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
    const b = await session
      .run({ userInput: 'Yes, those are the digits. Please check it.' })
      .wait()
    b.expect.nextEvent().isFunctionCall({ name: 'confirm_identifier' })
    b.expect.nextEvent().isFunctionCallOutput()
    const message = b.expect.nextEvent().isMessage({ role: 'assistant' })
    b.expect.noMoreEvents()
    expect(instance.state.conversation.itemId).toBe('0071842')
    expect(lookup).toHaveBeenCalledExactlyOnceWith(
      'verification',
      { itemId: '0071842', sellerId: undefined },
      expect.objectContaining({ access: 'public' }),
    )
    expect(
      b.events
        .filter(e => e.type === 'message')
        .some(
          e =>
            e.item.type === 'message' &&
            e.item.textContent?.includes('fixture-only'),
        ),
    ).toBe(true)
  } finally {
    await session.close()
  }
})
it('replaces an unsupported live-model claim at the real SDK output boundary', async () => {
  const model = new ScriptedModel(() => [
    {
      id: 'bad',
      delta: {
        role: 'assistant',
        content: 'This product is guaranteed genuine.',
      },
    },
  ])
  const session = new voice.AgentSession({
    llm: model,
    turnHandling: { turnDetection: 'manual' },
    userAwayTimeout: null,
  })
  const i = createPackProofAgent({
    provider: new PackProofVerificationProvider(
      new FixtureVerificationClient(),
    ),
    access: {
      sessionId: randomUUID(),
      room: 'test',
      identity: 'caller',
      subject: 'demo',
      access: 'public',
      scopes: ['verification:public'],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    },
    model,
  })
  i.bindSession(session)
  try {
    await session.start({ agent: i.agent, record: false })
    const r = await session.run({ userInput: 'Is it genuine?' }).wait()
    r.expect.nextEvent().isMessage({ role: 'assistant' })
    r.expect.noMoreEvents()
    expect(
      r.events.some(
        e =>
          e.type === 'message' &&
          e.item.textContent?.includes('guaranteed genuine'),
      ),
    ).toBe(false)
  } finally {
    await session.close()
  }
})
