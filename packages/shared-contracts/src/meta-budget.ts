import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// One durable ledger covers explicit tests and gateway-admitted voice calls.
// Reservations are never automatically refunded after uncertain provider work.
export class MetaBudget {
  private db: DatabaseSync
  private limit: number
  constructor(path: string, approvedUsd: number) {
    if (!Number.isFinite(approvedUsd) || approvedUsd <= 0 || approvedUsd > 10)
      throw new Error(
        'An explicit Meta budget within the approved US$10 is required',
      )
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.limit = Math.floor(approvedUsd * 1_000_000)
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,purpose TEXT NOT NULL,reserved_micro INTEGER NOT NULL,charged_micro INTEGER,state TEXT NOT NULL,created INTEGER NOT NULL);',
    )
  }
  reserve(purpose: string, usd = 0.05): string {
    const amount = Math.ceil(usd * 1_000_000)
    if (!Number.isSafeInteger(amount) || amount <= 0)
      throw new Error('Invalid Meta reservation')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const used = this.db
        .prepare(
          'SELECT COALESCE(SUM(COALESCE(charged_micro,reserved_micro)),0) as n FROM reservations',
        )
        .get()!.n as number
      if (used + amount > this.limit)
        throw new Error('Approved Meta budget exhausted')
      const id = randomUUID()
      this.db
        .prepare("INSERT INTO reservations VALUES(?,?,?,NULL,'reserved',?)")
        .run(id, purpose, amount, Date.now())
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  settle(
    id: string,
    { success, costUsd }: { success?: boolean; costUsd?: number } = {},
  ) {
    const row = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
    if (!row || row.state !== 'reserved')
      throw new Error('Unknown or settled Meta reservation')
    const charged = Number.isFinite(costUsd)
      ? Math.ceil(costUsd! * 1_000_000)
      : null
    if (
      charged !== null &&
      (charged < 0 || charged > (row.reserved_micro as number))
    )
      throw new Error(
        'Meta cost exceeded its reservation; stop and review pricing',
      )
    this.db
      .prepare(
        "UPDATE reservations SET state=?,charged_micro=? WHERE id=? AND state='reserved'",
      )
      .run(success ? 'completed' : 'failed', charged, id)
  }
  summary() {
    const row = this.db
      .prepare(
        'SELECT count(*) as requests,COALESCE(SUM(COALESCE(charged_micro,reserved_micro)),0) as committed,COALESCE(SUM(charged_micro),0) as estimated,COALESCE(SUM(CASE WHEN charged_micro IS NULL THEN reserved_micro ELSE 0 END),0) as uncertain FROM reservations',
      )
      .get() as {
      requests: number
      committed: number
      estimated: number
      uncertain: number
    }
    return {
      approvedUsd: this.limit / 1_000_000,
      estimatedKnownCostUsd: row.estimated / 1_000_000,
      reservedOrUncertainUsd: row.uncertain / 1_000_000,
      conservativeRemainingUsd: (this.limit - row.committed) / 1_000_000,
      requests: row.requests,
    }
  }
  close() {
    this.db.close()
  }
}
