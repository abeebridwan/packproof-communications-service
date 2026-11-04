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
import {
  TokenSource,
  RoomEvent,
  ParticipantKind,
  DisconnectReason,
} from 'livekit-client'
import { VerificationResult } from '@packproof/shared-contracts'
import { checkVoiceMedia, microphoneMessage } from './mediaPreflight'

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
  const pending = useRef(false)
  async function connect() {
    if (pending.current) return
    pending.current = true
    setConnecting(true)
    setError('')
    try {
      const assertion = await props.getAssertion()
      // Ask for media access before reserving a paid session or consuming an invitation.
      await checkVoiceMedia()
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
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}))
        const retry = Number(
          failure.retryAfterSeconds ?? response.headers.get('Retry-After'),
        )
        throw new Error(
          response.status === 401
            ? 'Please sign in or use a fresh demo invitation.'
            : failure.code === 'budget_exhausted'
              ? 'The demo voice allowance is fully reserved. Please ask for a budget review.'
              : failure.code === 'rate_limited'
                ? `The voice request limit was reached. Try again in ${Number.isFinite(retry) && retry > 0 ? Math.ceil(retry / 60) + ' minute(s)' : 'a few minutes'}.`
                : failure.code === 'capacity_busy'
                  ? 'All voice channels are in use. Try again shortly.'
                  : 'The voice service could not connect. Your invitation can be retried if it has not expired.',
        )
      }
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
      pending.current = false
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
      {error && <p role="alert">{error}</p>}
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
    const disconnected = (reason?: DisconnectReason) => {
      cleanup()
      if (mounted)
        endRef.current(
          reason === DisconnectReason.CLIENT_INITIATED ||
            reason === DisconnectReason.ROOM_DELETED
            ? undefined
            : 'The voice connection was interrupted. Check your connection and WebRTC extension settings, then reconnect with a fresh invitation.',
        )
    }
    session.room.on(RoomEvent.Disconnected, disconnected)
    void session
      .start({
        tracks: { microphone: { enabled: true }, camera: { enabled: false } },
      })
      .catch((e: unknown) => {
        cleanup()
        if (mounted) endRef.current(microphoneMessage(e))
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
