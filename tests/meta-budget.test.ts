import { it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetaTestBudget } from '../scripts/meta-test-budget.mjs'
it('reserves before spending, persists across restarts and refuses to exceed the approved cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-meta-budget-'))
  const path = join(root, 'budget.sqlite')
  let b
  try {
    b = new MetaTestBudget(path, 10)
    const id = b.reserve('test', 6)
    expect(() => b.reserve('over-limit', 5)).toThrow('exhausted')
    b.close()
    b = new MetaTestBudget(path, 10)
    expect(b.summary().conservativeRemainingUsd).toBe(4)
    b.settle(id, { success: true, costUsd: 0.001 })
    expect(b.summary().conservativeRemainingUsd).toBe(9.999)
    expect(() => b.settle(id, { success: true, costUsd: 0 })).toThrow('settled')
  } finally {
    b?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
it('keeps uncertain failures charged to the reservation and rejects higher unapproved budgets', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-meta-budget-'))
  let b
  try {
    expect(() => new MetaTestBudget(join(root, 'bad.sqlite'), 11)).toThrow(
      'approved US$10',
    )
    b = new MetaTestBudget(join(root, 'budget.sqlite'), 0.1)
    const id = b.reserve('failed-test', 0.05)
    b.settle(id, { success: false })
    expect(b.summary().reservedOrUncertainUsd).toBe(0.05)
    expect(() => b.reserve('too-large', 0.06)).toThrow('exhausted')
  } finally {
    b?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
