import { ABANDON_MIN_GRACE_MS } from 'tula-closeline-db'
import { ABANDON_CASE_MAX_ATTEMPTS } from 'tula-closeline-db/schema'
import type {
  AbandonCaseStore,
  AbandonOutcome,
  ClaimedAbandonCase,
  NewAbandonCase,
} from '~/ports/abandon-cases'
import type { Clock } from '~/ports/clock'

type Stored = NewAbandonCase & {
  attempts: number
  nextAttemptAt: number
  resolvedAt: number | null
  outcome: AbandonOutcome | null
}

/** The memory store: the same rules as the table, on the fixed clock. Exposes its rows to tests. */
export type MemoryAbandonCases = AbandonCaseStore & {
  /** Every case, as stored (ids only). */
  readonly cases: readonly Readonly<Stored>[]
  /** Makes one open case due now, as the table's back-dated rows do in the integration tests. */
  makeDue: (id: string) => void
}

/** Builds the memory store; `clock` is the test's fixed clock, standing in for the database's. */
export function createMemoryAbandonCases(clock: Clock): MemoryAbandonCases {
  const rows = new Map<string, Stored>()
  const ofEnvironment = (environmentId: string) =>
    [...rows.values()].filter((row) => row.environmentId === environmentId)
  return {
    get cases() {
      return [...rows.values()]
    },
    makeDue(id) {
      const row = rows.get(id)
      if (row) {
        row.nextAttemptAt = Math.min(row.nextAttemptAt, clock.now().getTime())
      }
    },
    async record(input) {
      const clash = [...rows.values()].some(
        (row) =>
          row.environmentId === input.environmentId &&
          (row.attemptId === input.attemptId ||
            (input.organizationId !== null && row.organizationId === input.organizationId))
      )
      if (clash || rows.has(input.id)) {
        return false
      }
      const grace = Math.max(input.graceMs, ABANDON_MIN_GRACE_MS)
      rows.set(input.id, {
        ...input,
        attempts: 0,
        nextAttemptAt: input.attemptExpiresAt.getTime() + grace,
        resolvedAt: null,
        outcome: null,
      })
      return true
    },
    async learn(environmentId, id, organizationId) {
      const row = rows.get(id)
      if (!row || row.environmentId !== environmentId || row.resolvedAt !== null) {
        return 'unchanged'
      }
      if (row.organizationId !== null) {
        return 'unchanged'
      }
      if (ofEnvironment(environmentId).some((other) => other.organizationId === organizationId)) {
        return 'conflict'
      }
      row.organizationId = organizationId
      return 'learned'
    },
    async claim(environmentId, limit, leaseMs) {
      const now = clock.now().getTime()
      const due = ofEnvironment(environmentId)
        .filter(
          (row) =>
            row.resolvedAt === null &&
            row.attempts < ABANDON_CASE_MAX_ATTEMPTS &&
            row.nextAttemptAt <= now
        )
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit)
      return due.map((row): ClaimedAbandonCase => {
        row.attempts += 1
        row.nextAttemptAt = now + leaseMs
        return {
          id: row.id,
          organizationId: row.organizationId,
          userId: row.userId,
          attemptId: row.attemptId,
          attempts: row.attempts,
        }
      })
    },
    async resolve(environmentId, id, outcome) {
      const row = rows.get(id)
      if (!row || row.environmentId !== environmentId || row.resolvedAt !== null) {
        return false
      }
      row.resolvedAt = clock.now().getTime()
      row.outcome = outcome
      return true
    },
    async giveUpSpent(environmentId, limit) {
      const now = clock.now().getTime()
      const spent = ofEnvironment(environmentId)
        .filter(
          (row) =>
            row.resolvedAt === null &&
            row.attempts >= ABANDON_CASE_MAX_ATTEMPTS &&
            row.nextAttemptAt <= now
        )
        .slice(0, limit)
      for (const row of spent) {
        row.resolvedAt = now
        row.outcome = 'gave_up'
      }
      return spent.map((row) => row.id)
    },
    async purgeResolved(environmentId, limit) {
      const cutoff = clock.now().getTime() - 86_400_000
      const old = ofEnvironment(environmentId)
        .filter((row) => row.resolvedAt !== null && row.resolvedAt < cutoff)
        .slice(0, limit)
      for (const row of old) {
        rows.delete(row.id)
      }
      return old.length
    },
  }
}
