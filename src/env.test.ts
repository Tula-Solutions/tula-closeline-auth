import { expect, test } from 'bun:test'
import { databaseUrl, LOCAL_MASTER_KEY, loadEnv, masterKey, publicUrl } from './env'

test('configuration falls back to defaults for everything but the environment', () => {
  expect(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })).toEqual({
    ENVIRONMENT: 'local',
    REGION: 'us',
    TOKEN_AUDIENCE: 'closeline',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
    SHUTDOWN_GRACE_MS: 5_000,
    MAX_REQUEST_BODY_BYTES: 1_048_576,
    DB_POOL_MAX: 10,
    RETENTION_INTERVAL_MS: 600_000,
    RETENTION_BATCH_SIZE: 500,
    RETENTION_RUN_TIMEOUT_MS: 30_000,
    HASH_CONCURRENCY: 4,
    HASH_QUEUE: 16,
    BREACH_CHECK_CONCURRENCY: 8,
    BREACH_CHECK_QUEUE: 16,
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
  ['an empty connection pool', { DB_POOL_MAX: '0' }],
  ['a pool above 100 connections', { DB_POOL_MAX: '101' }],
  ['a purge interval of zero', { RETENTION_INTERVAL_MS: '0' }],
  ['a purge batch above 5000', { RETENTION_BATCH_SIZE: '5001' }],
  ['a purge run timeout of zero', { RETENTION_RUN_TIMEOUT_MS: '0' }],
  ['no hash slots', { HASH_CONCURRENCY: '0' }],
  ['a negative hash queue', { HASH_QUEUE: '-1' }],
  ['no breach lookup slots', { BREACH_CHECK_CONCURRENCY: '0' }],
  ['a breach queue above 1000', { BREACH_CHECK_QUEUE: '1001' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', REGION: 'us', ...source })).toThrow()
})

test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
  const source = {
    ENVIRONMENT: 'local',
    REGION: 'us',
    SHUTDOWN_GRACE_MS: '30001',
    SHUTDOWN_TIMEOUT_MS: '30000',
  }

  expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
})

test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    REGION: 'us',
    SHUTDOWN_GRACE_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '30000',
  })

  expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
})

test('a deploy outside local must set the database, the master key and the public URL', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'prod', REGION: 'us' })).toThrow(
    /DATABASE_URL.*AUTH_MASTER_KEY.*PUBLIC_URL/s
  )
})

test('a deploy outside local boots with all three set', () => {
  const env = loadEnv({
    ENVIRONMENT: 'prod',
    REGION: 'eu',
    DATABASE_URL: 'postgres://closeline_auth:x@db/closeline',
    AUTH_MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'https://auth.eu.example.com/',
  })

  expect(publicUrl(env)).toBe('https://auth.eu.example.com')
  expect(masterKey(env)).toBe('ab'.repeat(32))
})

test.each([
  ['a master key that is not hex', { AUTH_MASTER_KEY: 'z'.repeat(64) }],
  ['a master key of the wrong length', { AUTH_MASTER_KEY: 'ab'.repeat(31) }],
  ['an unknown Region', { REGION: 'asia' }],
  ['a public URL that is not a URL', { PUBLIC_URL: 'auth' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', REGION: 'us', ...source })).toThrow()
})

test('a deploy with no Region fails at boot', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local' })).toThrow(/REGION/)
})

test('local falls back to the development key and the compose database, and nowhere else', () => {
  const env = loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })

  expect(masterKey(env)).toBe(LOCAL_MASTER_KEY)
  expect(databaseUrl(env, { POSTGRES_PORT: '5434' })).toContain('127.0.0.1:5434/closeline')
  expect(publicUrl(env)).toBe('http://localhost:3000')
})
