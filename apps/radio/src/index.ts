import { DatabaseSync } from 'node:sqlite'
import { createConnection } from 'node:net'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  BroadcastEnvelope,
  boundedJson,
  trustedEndpoint,
} from '@packproof/shared-contracts'
import { KokoroClient, MuseScriptClient, type Draft } from '@packproof/speech'

export interface EventSource {
  readonly fixture: boolean
  poll(cursor: string): Promise<{ events: BroadcastEnvelope[]; cursor: string }>
}
export class HttpEventSource implements EventSource {
  readonly fixture = false
  private url: URL
  constructor(
    url: string,
    private token: string,
    private request: typeof fetch = fetch,
  ) {
    this.url = trustedEndpoint(url)
    if (!token) throw new Error('RADIO_EVENT_SOURCE_TOKEN required')
  }
  async poll(cursor: string) {
    const u = new URL(this.url)
    u.searchParams.set('cursor', cursor)
    const r = await this.request(u, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    })
    return z
      .object({
        events: z.array(BroadcastEnvelope).max(20),
        cursor: z.string().max(512),
      })
      .parse(await boundedJson(r, 65536))
  }
}
export class FixtureEventSource implements EventSource {
  readonly fixture = true
  async poll(cursor: string) {
    return { cursor: 'demo-bulletin-1', events: cursor ? [] : [fixtureEvent()] }
  }
}
export function fixtureEvent(): BroadcastEnvelope {
  const now = new Date().toISOString()
  return {
    candidate: {
      eventId: 'demo-bulletin-1',
      itemId: '0071842',
      noticeRecordId: 'sample-notice-1',
      noticeType: 'demo_product_bulletin',
      scope: 'demo_public',
      effectiveAt: now,
      asOf: now,
      evidenceRefs: ['sample-evidence-1'],
      policyVersion: 'packproof-demo-radio-v1',
      demo: true,
      publicSummary: 'A sample published product bulletin.',
      idempotencyKey: 'demo-bulletin-1',
    },
    authorization: {
      eligible: true,
      signatureVerified: true,
      publication: 'demo_public',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      sourceRecordId: 'sample-notice-1',
    },
  }
}
export function validateCandidate(
  raw: unknown,
  now = Date.now(),
): BroadcastEnvelope {
  const e = BroadcastEnvelope.parse(raw),
    c = e.candidate
  if (
    e.authorization.sourceRecordId !== c.noticeRecordId ||
    Date.parse(c.effectiveAt) > now ||
    Date.parse(c.asOf) > now + 30000 ||
    now - Date.parse(c.asOf) > 900000 ||
    Date.parse(e.authorization.expiresAt) <= now ||
    Date.parse(e.authorization.expiresAt) > Date.parse(c.asOf) + 3600000
  )
    throw new Error('Notice binding or freshness failed')
  return e
}
export function radioSentences(
  e: BroadcastEnvelope,
  fixture: boolean,
): string[] {
  const phrases = {
    demo_warning: 'A signed sample warning is available in PackProof.',
    demo_recall:
      'A signed sample recall or withdrawal notice is available in PackProof.',
    demo_packaging_change:
      'A signed sample packaging change notice is available in PackProof.',
    demo_product_bulletin:
      'A published sample product bulletin is available in PackProof.',
  }
  const intro = fixture
    ? 'This is a fixture-only PackProof radio demonstration. No real signed notice has been verified.'
    : 'This is a PackProof demo announcement, not a public safety alert.'
  // The arbitrary publicSummary is deliberately excluded from inference and speech.
  return [
    intro,
    fixture
      ? 'A sample product bulletin is available for demonstration.'
      : phrases[e.candidate.noticeType],
    `The product code is ${[...e.candidate.itemId].map(c => (c === '0' ? 'zero' : c === '-' ? 'hyphen' : c)).join(', ')}.`,
    'Review the evidence and applicable notice in PackProof.',
  ]
}
export type RadioState =
  | 'accepted'
  | 'generated'
  | 'queued'
  | 'started'
  | 'completed'
  | 'failed'
  | 'dead_letter'
export type RadioRow = {
  event_id: string
  idempotency_key: string
  envelope: string
  state: RadioState
  attempts: number
  playback_id: string | null
  updated: number
  path: string | null
  error: string | null
  script_source: string | null
}
export class RadioLedger {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(
      `PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,playback_id TEXT UNIQUE,updated INTEGER NOT NULL,path TEXT,error TEXT,script_source TEXT);CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS receipts(playback_id TEXT NOT NULL,kind TEXT NOT NULL,received INTEGER NOT NULL,PRIMARY KEY(playback_id,kind));`,
    )
  }
  cursor() {
    return (
      (
        this.db.prepare("SELECT value FROM state WHERE key='cursor'").get() as
          | { value: string }
          | undefined
      )?.value ?? ''
    )
  }
  acceptBatch(events: unknown[], cursor: string) {
    const validated = events.map(e => validateCandidate(e)) // invalid batch cannot advance the cursor
    this.db.exec('BEGIN IMMEDIATE')
    let added = 0
    try {
      for (const e of validated) {
        const change = this.db
          .prepare(
            "INSERT OR IGNORE INTO events(event_id,idempotency_key,envelope,state,updated) VALUES(?,?,?,'accepted',?)",
          )
          .run(
            e.candidate.eventId,
            e.candidate.idempotencyKey,
            JSON.stringify(e),
            Date.now(),
          )
        added += Number(change.changes)
      }
      this.db
        .prepare(
          "INSERT INTO state VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(cursor)
      this.db.exec('COMMIT')
      return added
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  get(eventId: string) {
    return this.db
      .prepare('SELECT * FROM events WHERE event_id=?')
      .get(eventId) as RadioRow | undefined
  }
  next() {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE state IN ('accepted','failed','generated') AND attempts<3 ORDER BY updated LIMIT 1",
      )
      .get() as RadioRow | undefined
  }
  counts() {
    return this.db
      .prepare('SELECT state,count(*) as count FROM events GROUP BY state')
      .all()
  }
  fail(id: string, code: string) {
    this.db
      .prepare(
        "UPDATE events SET state=CASE WHEN attempts>=3 THEN 'dead_letter' ELSE 'failed' END,error=?,updated=? WHERE event_id=? AND state!='completed'",
      )
      .run(code, Date.now(), id)
  }
  begin(id: string) {
    const playbackId = randomBytes(16).toString('hex')
    this.db
      .prepare(
        "UPDATE events SET attempts=attempts+1,playback_id=?,updated=? WHERE event_id=? AND state IN ('accepted','failed','generated')",
      )
      .run(playbackId, Date.now(), id)
    return playbackId
  }
  generated(id: string, path: string, draft: Draft) {
    this.db
      .prepare(
        "UPDATE events SET state='generated',path=?,script_source=?,updated=? WHERE event_id=?",
      )
      .run(path, draft.source, Date.now(), id)
  }
  queued(id: string) {
    this.db
      .prepare(
        "UPDATE events SET state='queued',updated=? WHERE event_id=? AND state='generated'",
      )
      .run(Date.now(), id)
  }
  active() {
    return this.db
      .prepare("SELECT * FROM events WHERE state IN ('queued','started')")
      .all() as RadioRow[]
  }
  receipt(
    playbackId: string,
    kind: 'started' | 'completed',
    streamActive: boolean,
  ) {
    if (!streamActive) throw new Error('No active Icecast source')
    const row = this.db
      .prepare('SELECT * FROM events WHERE playback_id=?')
      .get(playbackId) as RadioRow | undefined
    if (!row) throw new Error('Unknown playback')
    if (
      this.db
        .prepare('SELECT 1 FROM receipts WHERE playback_id=? AND kind=?')
        .get(playbackId, kind)
    )
      return
    const expected = kind === 'started' ? 'queued' : 'started'
    if (row.state !== expected) throw new Error('Invalid playback transition')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO receipts VALUES(?,?,?)')
        .run(playbackId, kind, Date.now())
      this.db
        .prepare(
          'UPDATE events SET state=?,updated=? WHERE event_id=? AND state=?',
        )
        .run(kind, Date.now(), row.event_id, expected)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  close() {
    this.db.close()
  }
}
export interface Player {
  queue(path: string, playbackId: string): Promise<void>
  isStreaming(): Promise<boolean>
}
export class LiquidsoapPlayer implements Player {
  constructor(
    private host: string,
    private port: number,
    private icecastUrl: string,
  ) {}
  async queue(path: string, playbackId: string): Promise<void> {
    if (
      !/^\/data\/media\/[a-f0-9]{32}\.wav$/.test(path) ||
      !/^[a-f0-9]{32}$/.test(playbackId)
    )
      throw new Error('Invalid queue path')
    const command = `announcements.push annotate:pp_playback_id="${playbackId}":${path}\n`
    await new Promise<void>((resolve, reject) => {
      let data = ''
      const socket = createConnection(
        { host: this.host, port: this.port },
        () => socket.write(command),
      )
      socket.setTimeout(5000)
      socket.on('timeout', () => socket.destroy(new Error('Player timeout')))
      socket.on('error', reject)
      socket.on('data', chunk => {
        data += chunk.toString()
        if (data.length > 4096)
          socket.destroy(new Error('Player response too large'))
        if (data.includes('END')) {
          socket.end()
          if (/(?:^|\n)\d+\r?\n/.test(data)) resolve()
          else reject(new Error('Queue rejected'))
        }
      })
    })
  }
  async isStreaming() {
    try {
      const response = await fetch(
        new URL('/status-json.xsl', this.icecastUrl),
        { signal: AbortSignal.timeout(3000) },
      )
      const data = (await boundedJson(response, 16000)) as {
        icestats?: {
          source?: { listenurl?: string } | { listenurl?: string }[]
        }
      }
      const src = data.icestats?.source
      return (Array.isArray(src) ? src : src ? [src] : []).some(s =>
        s.listenurl?.endsWith('/packproof.mp3'),
      )
    } catch {
      return false
    }
  }
}
export class RadioWorker {
  constructor(
    readonly ledger: RadioLedger,
    private source: EventSource,
    private speech: KokoroClient,
    private muse: MuseScriptClient,
    private player: Player,
    private mediaDir: string,
    private log: (event: string) => void = () => {},
  ) {
    mkdirSync(mediaDir, { recursive: true })
  }
  async poll() {
    const batch = await this.source.poll(this.ledger.cursor())
    return this.ledger.acceptBatch(batch.events, batch.cursor)
  }
  async tick() {
    for (const old of this.ledger.active())
      if (Date.now() - old.updated > 120000)
        this.ledger.fail(old.event_id, 'playback_receipt_timeout')
    if (this.ledger.active().length || !(await this.player.isStreaming()))
      return
    const row = this.ledger.next()
    if (!row) return
    const playbackId = this.ledger.begin(row.event_id)
    try {
      const envelope = validateCandidate(JSON.parse(row.envelope))
      const script = await this.muse.compose(
        radioSentences(envelope, this.source.fixture),
      )
      const wav = await this.speech.wav(script.text)
      const path = join(this.mediaDir, playbackId + '.wav')
      writeFileSync(path + '.tmp', wav, { mode: 0o644 })
      renameSync(path + '.tmp', path)
      this.ledger.generated(row.event_id, path, script)
      validateCandidate(envelope) // recheck expiry after synthesis
      await this.player.queue('/data/media/' + playbackId + '.wav', playbackId)
      this.ledger.queued(row.event_id)
      this.log('queued')
    } catch {
      this.ledger.fail(row.event_id, 'generation_or_queue_failed')
      this.log('failed')
    }
  }
  async receipt(playbackId: string, kind: 'started' | 'completed') {
    this.ledger.receipt(playbackId, kind, await this.player.isStreaming())
    this.log(kind)
  }
}
