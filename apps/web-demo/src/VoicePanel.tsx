import { useEffect, useMemo, useRef, useState } from 'react'
import {
  RoomAudioRenderer,
  RoomContext,
  SessionProvider,
  useAgent,
  useDataChannel,
  useSession,
  useSessionMessages,
} from '@livekit/components-react'
import { TokenSource, RoomEvent, ParticipantKind } from 'livekit-client'
import { VerificationResult } from '@packproof/shared-contracts'

export type VoicePanelProps = {
  gatewayUrl: string
  getAssertion: () => Promise<string>
  radioUrl?: string
}
type Lease = { sessionId: string; cleanupToken: string; expiresAt: number }
type Connection = Lease & { serverUrl: string; participantToken: string }
export function VoicePanel(props: VoicePanelProps) {
  const [connection, setConnection] = useState<Connection>()
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  async function connect() {
    setConnecting(true)
    setError('')
    try {
      const assertion = await props.getAssertion()
      const response = await fetch(
        props.gatewayUrl.replace(/\/$/, '') + '/v1/voice/sessions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${assertion}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(15000),
        },
      )
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? 'Please sign in or use a fresh demo invitation.'
            : response.status === 429
              ? 'Voice sessions are busy. Please try later.'
              : 'The voice service could not connect.',
        )
      const data = await response.json()
      if (
        typeof data.serverUrl !== 'string' ||
        !data.serverUrl.startsWith('wss://') ||
        typeof data.participantToken !== 'string' ||
        typeof data.cleanupToken !== 'string' ||
        typeof data.sessionId !== 'string' ||
        typeof data.expiresAt !== 'number'
      )
        throw new Error('Invalid session response')
      setConnection(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Voice connection unavailable.')
    } finally {
      setConnecting(false)
    }
  }
  return (
    <section className="voice-panel" aria-label="Talk to PackProof">
      <p className="eyebrow">PACKPROOF COMMUNICATIONS</p>
      <h1>Talk through the evidence.</h1>
      <p>
        Ask about a product, its seller, or the evidence recorded in PackProof.
      </p>
      {connection ? (
        <ActiveCall
          {...props}
          connection={connection}
          onEnd={message => {
            setConnection(undefined)
            setError(message ?? '')
          }}
        />
      ) : (
        <button disabled={connecting} onClick={() => void connect()}>
          {connecting ? 'Connecting…' : 'Connect microphone'}
        </button>
      )}
      {error && (
        <p role="alert">{error} You can retry with a new authorized session.</p>
      )}
      <p className="muted">
        Calls last up to five minutes. Voice cannot inspect a physical item or
        sign a transfer.
      </p>
      <a
        href="https://packproof-p0.vercel.app/review"
        target="_blank"
        rel="noreferrer"
      >
        Continue in PackProof Inspector ↗
      </a>
      {props.radioUrl && (
        <aside>
          <h2>PackProof demo radio</h2>
          <audio controls preload="none" src={props.radioUrl} />
          <p>Sample notices and original background music.</p>
        </aside>
      )}
    </section>
  )
}
function ActiveCall({
  gatewayUrl,
  connection,
  onEnd,
}: VoicePanelProps & {
  connection: Connection
  onEnd: (message?: string) => void
}) {
  const lease = useRef<Lease | undefined>(connection)
  const endRef = useRef(onEnd)
  endRef.current = onEnd
  const [result, setResult] = useState<VerificationResult>()
  // A fetched lease belongs to this one mounted call. SDK token refreshes cannot
  // issue a second room or consume the one-use assertion on disconnect.
  const source = useMemo(
    () =>
      TokenSource.literal({
        serverUrl: connection.serverUrl,
        participantToken: connection.participantToken,
      }),
    [connection],
  )
  const session = useSession(source)
  const agent = useAgent(session)
  const { messages } = useSessionMessages(session)
  useEffect(() => {
    let mounted = true
    const cleanup = () => {
      const l = lease.current
      if (!l) return
      lease.current = undefined
      void fetch(
        gatewayUrl.replace(/\/$/, '') + '/v1/voice/sessions/' + l.sessionId,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${l.cleanupToken}` },
          keepalive: true,
        },
      ).catch(() => {})
    }
    const disconnected = () => {
      cleanup()
      if (mounted) endRef.current()
    }
    session.room.on(RoomEvent.Disconnected, disconnected)
    void session
      .start({
        tracks: { microphone: { enabled: true }, camera: { enabled: false } },
      })
      .catch((e: unknown) => {
        cleanup()
        if (mounted)
          endRef.current(
            e instanceof Error
              ? e.message
              : 'Microphone or connection unavailable.',
          )
      })
    return () => {
      mounted = false
      session.room.off(RoomEvent.Disconnected, disconnected)
      void session.end().finally(cleanup)
    }
  }, [source])
  useEffect(() => {
    if (!lease.current) return
    const t = setTimeout(
      () => endRef.current('The session has ended.'),
      Math.max(0, lease.current.expiresAt * 1000 - Date.now()),
    )
    return () => clearTimeout(t)
  }, [session.connectionState])
  return (
    <SessionProvider session={session}>
      <RoomContext.Provider value={session.room}>
        <RoomAudioRenderer />
        <ResultReceiver onResult={setResult} />
        <div className={'status ' + agent.state} role="status">
          <span className="orb" />
          {session.connectionState === 'reconnecting'
            ? 'Reconnecting…'
            : agent.state === 'speaking'
              ? 'PackProof is speaking'
              : agent.state === 'listening'
                ? 'Listening'
                : agent.state === 'thinking'
                  ? 'Checking the evidence'
                  : agent.state === 'failed'
                    ? 'Agent unavailable'
                    : 'Connecting…'}
        </div>
        <button className="secondary" onClick={() => endRef.current()}>
          Disconnect
        </button>
        <div className="transcript" aria-live="polite">
          {messages.slice(-40).map((m, i) => (
            <p key={m.id ?? i}>{m.message}</p>
          ))}
        </div>
        {result && (
          <article>
            <p className="eyebrow">
              {result.fixture
                ? 'FIXTURE DEMONSTRATION'
                : 'PACKPROOF SOURCE RESULT'}
            </p>
            <h2>
              {result.itemId} · {result.status.replace('_', ' ')}
            </h2>
            <p>As of {new Date(result.asOf).toLocaleString()}</p>
            <ul>
              {result.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            <h3>Evidence references</h3>
            {result.sources.map(s => (
              <p key={s.id}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.recordId}
                </a>
              </p>
            ))}
          </article>
        )}
      </RoomContext.Provider>
    </SessionProvider>
  )
}
function ResultReceiver({
  onResult,
}: {
  onResult: (r: VerificationResult) => void
}) {
  useDataChannel('packproof.verification', message => {
    if (
      message.from?.kind !== ParticipantKind.AGENT ||
      message.payload.byteLength > 32768
    )
      return
    try {
      const parsed = VerificationResult.safeParse(
        JSON.parse(new TextDecoder().decode(message.payload)),
      )
      if (parsed.success) onResult(parsed.data)
    } catch {
      /* discard malformed data */
    }
  })
  return null
}
