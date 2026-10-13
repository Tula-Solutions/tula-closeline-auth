import type { Container } from '~/container'
import type { Tenant } from '~/ports/fixed-project'

/** An age that is expired for longer than the purge's grace for a call to core. */
export const LONG_EXPIRED_MS = 60_000

/** What the retention tests plant: attempts and codes, expired or live. */
export type Seeder = {
  /** Stores `n` attempts that expired `ageMs` ago (a negative age is still live). */
  attempts: (n: number, ageMs: number) => Promise<string[]>
  /** Stores `n` codes of their own attempts, expired `ageMs` ago. */
  tokens: (n: number, ageMs: number) => Promise<void>
}

/**
 * Plants rows for the retention tests, relative to the container's clock.
 *
 * @param deps - The container whose stores are written.
 * @param tenant - The tenant the rows belong to.
 */
export function seeder(
  deps: Pick<Container, 'clock' | 'ids' | 'flowAttempts' | 'verificationTokens'>,
  tenant: Tenant
): Seeder {
  const attempts: Seeder['attempts'] = async (n, ageMs) => {
    const now = deps.clock.now()
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const id = deps.ids.next()
      ids.push(id)
      await deps.flowAttempts.create({
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        kind: 'sign_up',
        status: 'needs_email_verification',
        userId: null,
        identifier: `seed${i}@northline.app`,
        secretHash: 'a'.repeat(64),
        state: { client: 'web', passwordHash: '$argon2id$pending' },
        expiresAt: new Date(now.getTime() - ageMs),
        createdAt: new Date(now.getTime() - ageMs - 600_000),
      })
    }
    return ids
  }
  return {
    attempts,
    tokens: async (n, ageMs) => {
      const now = deps.clock.now()
      for (const flowAttemptId of await attempts(n, -3_600_000)) {
        await deps.verificationTokens.replace(
          {
            id: deps.ids.next(),
            projectId: tenant.projectId,
            environmentId: tenant.environmentId,
            userId: null,
            flowAttemptId,
            purpose: 'email_verification',
            destination: 'seed@northline.app',
            codeHash: 'b'.repeat(64),
            linkTokenHash: null,
            maxAttempts: 5,
            expiresAt: new Date(now.getTime() - ageMs),
            createdAt: new Date(now.getTime() - ageMs - 600_000),
          },
          now
        )
      }
    },
  }
}
