import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { startFakeCore } from '~/testing/fake-core'
import { createContainer, createMembership, reportSafely } from './container'
import { type Env, loadEnv } from './env'

test('the default reportError logs the failure with its request context at error level', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'a'.repeat(32)}` as never

  container.reportError(new Error('disk on fire'), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
    level: 50, // error
    msg: 'unhandled error',
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
    error: { name: 'Error', message: 'disk on fire' },
  })
})

test('the default reportError logs the stack frames and the whole cause chain', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'c'.repeat(32)}` as never
  const error = new Error('query failed', { cause: new TypeError('socket closed') })

  container.reportError(error, { requestId, method: 'GET', path: '/x', status: 500 })

  const logged = JSON.parse(lines[0] ?? '{}')
  expect(logged.error.stack.length).toBeGreaterThan(0)
  expect(logged.error.cause).toMatchObject({ name: 'TypeError', message: 'socket closed' })
})

test('the default reportError bounds a long message', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'d'.repeat(32)}` as never

  container.reportError(new Error('z'.repeat(50_000)), {
    requestId,
    method: 'GET',
    path: '/x',
    status: 500,
  })

  expect((lines[0] ?? '').length).toBeLessThan(5_000)
})

test('reportSafely swallows a reporter that throws or rejects', async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', listener)
  const container = createContainer(
    loadEnv({ ENVIRONMENT: 'local', REGION: 'us', LOG_LEVEL: 'silent' })
  )
  const context = {
    requestId: `req_${'e'.repeat(32)}` as never,
    method: 'GET',
    path: '/x',
    status: 500,
  }

  try {
    container.reportError = () => {
      throw new Error('sync failure')
    }
    reportSafely(container, new Error('a'), context)
    container.reportError = (async () => {
      throw new Error('async failure')
    }) as never
    reportSafely(container, new Error('b'), context)
    await Bun.sleep(20)

    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('the default reportError records a thrown non-Error without its value', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'b'.repeat(32)}` as never

  container.reportError('password=hunter2', { requestId, method: 'GET', path: '/x', status: 500 })

  expect(lines[0]).not.toContain('hunter2')
})

test('LOG_LEVEL silences the logger', () => {
  const lines: string[] = []
  const container = createContainer(
    loadEnv({ ENVIRONMENT: 'local', REGION: 'us', LOG_LEVEL: 'silent' }),
    {
      logDestination: { write: (l) => lines.push(l) },
    }
  )

  container.logger.error('nothing to see')

  expect(lines).toHaveLength(0)
})

test('a container built from the environment checks the database and the bootstrap', () => {
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }))

  expect(container.readinessChecks.map((check) => check.name)).toEqual(['database', 'bootstrap'])
})

describe('which membership adapter the container builds', () => {
  const userId = formatId('usr', crypto.randomUUID())
  const quiet = { warn: () => {} }

  test('local without core settings runs on the placeholder: no membership, none can be made', async () => {
    const membership = createMembership(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }), quiet)

    expect(await membership.forUser(userId)).toBeNull()
    await expect(
      membership.createOrganization({ userId, name: 'A', idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/placeholder/)
  })

  test('with core settings it talks to core, with the secret, and not to the placeholder', async () => {
    const core = startFakeCore()
    try {
      const env = loadEnv({
        ENVIRONMENT: 'local',
        REGION: 'us',
        CORE_BASE_URL: core.url,
        CORE_INTERNAL_TOKEN: core.secret,
      })

      const created = await createMembership(env, quiet).createOrganization({
        userId,
        name: 'Northline',
        idempotencyKey: crypto.randomUUID(),
      })

      expect(created.role).toBe('owner')
      expect(core.requests[0]?.headers.authorization).toBe(`Bearer ${core.secret}`)
    } finally {
      await core.stop()
    }
  })

  test('outside local the placeholder can never be chosen: loading the settings fails, and so does building from an env that slipped past', () => {
    for (const environment of ['dev', 'staging', 'prod']) {
      expect(() =>
        loadEnv({
          ENVIRONMENT: environment,
          REGION: 'us',
          DATABASE_URL: 'postgres://x:y@db/closeline',
          AUTH_MASTER_KEY: 'ab'.repeat(32),
          PUBLIC_URL: 'https://auth.example.com',
        })
      ).toThrow(/CORE_BASE_URL/)
      const slipped = {
        ...loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }),
        ENVIRONMENT: environment,
      }
      expect(() => createMembership(slipped as Env, quiet)).toThrow(/required outside local/)
    }
  })

  test('the container built from a local env with core settings uses the HTTP adapter', async () => {
    const core = startFakeCore()
    try {
      const container = createContainer(
        loadEnv({
          ENVIRONMENT: 'local',
          REGION: 'us',
          LOG_LEVEL: 'silent',
          CORE_BASE_URL: core.url,
          CORE_INTERNAL_TOKEN: core.secret,
        })
      )

      expect(await container.membership.forUser(userId)).toBeNull()
      expect(core.requests).toHaveLength(1)
    } finally {
      await core.stop()
    }
  })
})
