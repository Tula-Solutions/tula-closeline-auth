import { createFixedClock, createLogger, type FixedClock } from 'tula-closeline-kit'
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
    env: loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'debug', ...overrides.env }),
    logger: createLogger({
      service: SERVICE,
      level: 'debug',
      destination: { write: (line) => void logLines.push(line) },
    }),
    clock: createFixedClock('2026-01-01T00:00:00Z'),
    readinessChecks: overrides.readinessChecks ?? [],
    lifecycle: { draining: false },
    reportError: (error, context) => {
      reported.push({ error, context })
    },
    logLines,
    reported,
  }
}
