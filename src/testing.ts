import { createFixedClock, createLogger, type FixedClock } from 'tula-closeline-kit'
import { createMemoryFixedProject } from '~/adapters/memory/fixed-project'
import { uuidV7Ids } from '~/adapters/system/ids'
import type { Container, ErrorContext, ReadinessCheck } from '~/container'
import { loadEnv } from '~/env'
import { SERVICE } from '~/info'

/** The container plus the observable side effects a test asserts on. */
export type TestDeps = Container & {
  clock: FixedClock
  /** Every JSON log line written, in order. */
  logLines: string[]
  /** Every call to `reportError`, in order. */
  reported: { error: unknown; context: ErrorContext }[]
}

/** Builds a container of in-memory doubles and a fixed clock; `overrides` replace any field. */
export function createTestDeps(
  overrides: { readinessChecks?: readonly ReadinessCheck[]; env?: Record<string, string> } = {}
): TestDeps {
  const logLines: string[] = []
  const reported: TestDeps['reported'] = []

  return {
    env: loadEnv({
      ENVIRONMENT: 'local',
      REGION: 'eu',
      LOG_LEVEL: 'debug',
      DATABASE_URL: 'postgres://closeline_auth:unused@127.0.0.1:1/closeline',
      AUTH_MASTER_KEY: 'ab'.repeat(32),
      PUBLIC_URL: 'https://auth.test.example.com',
      ...overrides.env,
    }),
    logger: createLogger({
      service: SERVICE,
      level: 'debug',
      destination: { write: (line) => void logLines.push(line) },
    }),
    clock: createFixedClock('2026-01-01T00:00:00Z'),
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    ids: uuidV7Ids,
    fixedProject: createMemoryFixedProject(),
    tenant: {},
    close: async () => {},
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    logLines,
    reported,
  }
}
