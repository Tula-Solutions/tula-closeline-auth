import { expect, test } from 'bun:test'
import { loadEnv } from './env'

test('configuration falls back to defaults for everything but the environment', () => {
  expect(loadEnv({ ENVIRONMENT: 'local' })).toEqual({
    ENVIRONMENT: 'local',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
    SHUTDOWN_GRACE_MS: 5_000,
    MAX_REQUEST_BODY_BYTES: 1_048_576,
  })
})

test('a deploy without ENVIRONMENT fails at boot instead of running as local', () => {
  expect(() => loadEnv({})).toThrow()
})

test.each([
  ['an unknown environment', { ENVIRONMENT: 'production' }],
  ['an unknown log level', { LOG_LEVEL: 'verbose' }],
  ['a port out of range', { PORT: '70000' }],
  ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
  ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
  ['a negative shutdown grace', { SHUTDOWN_GRACE_MS: '-1' }],
  ['a zero body limit', { MAX_REQUEST_BODY_BYTES: '0' }],
  ['a body limit above 100 MB', { MAX_REQUEST_BODY_BYTES: '104857601' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', ...source })).toThrow()
})

test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
  const source = { ENVIRONMENT: 'local', SHUTDOWN_GRACE_MS: '30001', SHUTDOWN_TIMEOUT_MS: '30000' }

  expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
})

test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    SHUTDOWN_GRACE_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '30000',
  })

  expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
})
