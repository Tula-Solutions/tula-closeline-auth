/** How an abandon case ended: the Organization is gone or none is owed, core refused, or we gave up. */
export type AbandonOutcome = 'done' | 'refused' | 'gave_up'

/** What a sign-up records before it asks core for an Organization. */
export interface NewAbandonCase {
  /** The case id; the attempt id, so every request of one attempt addresses the same case. */
  id: string
  projectId: string
  environmentId: string
  /** The Organization id (`org_...`) when known, `null` before core has answered. */
  organizationId: string | null
  /** The user id (a bare uuid) the attempt fixed. */
  userId: string
  /** The flow attempt id (a bare uuid). */
  attemptId: string
  /** When the attempt can no longer write an account. */
  attemptExpiresAt: Date
  /** How long past the expiry a request that started before it can still commit its account. */
  graceMs: number
}

/** A case a sweep holds the lease on. Ids only: no address, no name. */
export interface ClaimedAbandonCase {
  id: string
  /** `org_...`, or `null` when core's answer was never recorded. */
  organizationId: string | null
  userId: string
  attemptId: string
  /** How many times the case has been claimed, this claim included. */
  attempts: number
}

/** The result of filling in an Organization id. */
export type LearnResult = 'learned' | 'unchanged' | 'conflict'

/**
 * The durable record of Organizations that core made during a sign-up whose account may never be
 * written (hub issue 36, ADR 0011). The database clock decides when a case is due; every method
 * is its own short transaction, so nothing is held across a call to core.
 */
export interface AbandonCaseStore {
  /** Records a case once; returns `false` when one already exists for the attempt or Organization. */
  record(input: NewAbandonCase): Promise<boolean>

  /** Reads where a case stands, or `null` when there is none. */
  find(environmentId: string, id: string): Promise<{ resolved: boolean; attempts: number } | null>

  /**
   * Fills in the Organization id, once. `conflict` means another case already holds that
   * Organization id; the caller resolves this case as `gave_up` and reports the ids.
   */
  learn(environmentId: string, id: string, organizationId: string): Promise<LearnResult>

  /**
   * Leases up to `limit` due cases for `leaseMs`: a case is due once its attempt can no longer
   * write an account (expiry plus grace). Two callers never get the same case; a case nobody
   * resolves is due again when the lease ends.
   */
  claim(environmentId: string, limit: number, leaseMs: number): Promise<ClaimedAbandonCase[]>

  /** Records the outcome; `false` when the case was already resolved (not an error). */
  resolve(environmentId: string, id: string, outcome: AbandonOutcome): Promise<boolean>

  /** Resolves open cases that used every attempt the table allows; returns their ids. */
  giveUpSpent(environmentId: string, limit: number): Promise<string[]>

  /** Deletes resolved cases a day old or more, one bounded batch; returns how many. */
  purgeResolved(environmentId: string, limit: number): Promise<number>
}
