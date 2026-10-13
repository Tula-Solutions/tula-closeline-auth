import { describe, expect, test } from 'bun:test'
import { formatId } from 'tula-closeline-contract'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MailerNotConfigured } from '~/adapters/unconfigured/mailer'
import { startFakeCore } from '~/testing/fake-core'
import { createContainer, createMailer, createMembership, reportSafely } from './container'
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

describe('where the counters live', () => {
  test('the container counts sign-in tries and rate limits in the database, not in process memory', () => {
    const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }))

    expect(container.lockout).not.toBeInstanceOf(MemoryLockout)
    expect(container.rateLimiter).not.toBeInstanceOf(MemoryRateLimiter)
    expect(container.counterPurger).toBeDefined()
  })

  test('before the fixed project is bootstrapped a count fails instead of being allowed', async () => {
    const container = createContainer(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }))

    await expect(container.rateLimiter.hit('k', 1, 1_000)).rejects.toThrow('not bootstrapped')
    await expect(
      container.lockout.attempt(
        'k',
        { freeAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, forgetAfterMs: 1 },
        new Date()
      )
    ).rejects.toThrow('not bootstrapped')
  })
})

describe('which membership adapter the container builds', () => {
  const userId = formatId('usr', crypto.randomUUID())
  const quiet = { warn: () => {} }

  test('local without core settings runs on the placeholder: no membership, none can be made', async () => {
    const membership = createMembership(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }), quiet)

    expect(await membership.forUser(userId)).toBeNull()
    await expect(
      membership.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId,
        name: 'A',
        idempotencyKey: crypto.randomUUID(),
      })
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
        email: 'maya@northline.app',
        memberName: null,
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

  test('the limits on calls to core come from the settings', async () => {
    const core = startFakeCore()
    try {
      const env = loadEnv({
        ENVIRONMENT: 'local',
        REGION: 'us',
        CORE_BASE_URL: core.url,
        CORE_INTERNAL_TOKEN: core.secret,
        CORE_CONCURRENCY: '1',
        CORE_QUEUE: '0',
      })
      const membership = createMembership(env, quiet)
      core.script({ kind: 'hang' })
      const controller = new AbortController()
      const stalled = membership.forUser(userId, controller.signal)
      await core.untilRequests(1)

      await expect(membership.forUser(userId)).rejects.toThrow(/too many calls/)

      expect(core.requests).toHaveLength(1)
      controller.abort()
      await expect(stalled).rejects.toThrow()
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

describe('the mailer', () => {
  const MESSAGE = { to: 'rep@example.com', subject: 'Hello', text: 'text', html: '<p>html</p>' }

  test('without MAIL_LOCAL_URL the unconfigured mailer stays', async () => {
    const container = createContainer(
      loadEnv({ ENVIRONMENT: 'local', REGION: 'us', LOG_LEVEL: 'silent' })
    )

    await expect(container.mailer.send(MESSAGE)).rejects.toBeInstanceOf(MailerNotConfigured)
  })

  test('with MAIL_LOCAL_URL the local mailbox adapter hands the message over', async () => {
    const bodies: unknown[] = []
    const mailbox = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        bodies.push({ path: new URL(request.url).pathname, body: await request.json() })
        return Response.json({ ID: 'x' })
      },
    })
    try {
      const container = createContainer(
        loadEnv({
          ENVIRONMENT: 'local',
          REGION: 'us',
          LOG_LEVEL: 'silent',
          MAIL_LOCAL_URL: `http://127.0.0.1:${mailbox.port}`,
        })
      )

      await container.mailer.send(MESSAGE)

      expect(bodies).toEqual([
        {
          path: '/api/v1/send',
          body: {
            From: { Email: 'no-reply@closeline.test' },
            To: [{ Email: 'rep@example.com' }],
            Subject: 'Hello',
            Text: 'text',
            HTML: '<p>html</p>',
          },
        },
      ])
    } finally {
      await mailbox.stop(true)
    }
  })

  test('MAIL_LOCAL_FROM changes the sender', async () => {
    const froms: unknown[] = []
    const mailbox = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        froms.push(((await request.json()) as { From: unknown }).From)
        return Response.json({ ID: 'x' })
      },
    })
    try {
      const container = createContainer(
        loadEnv({
          ENVIRONMENT: 'local',
          REGION: 'us',
          LOG_LEVEL: 'silent',
          MAIL_LOCAL_URL: `http://127.0.0.1:${mailbox.port}`,
          MAIL_LOCAL_FROM: 'sender@dev.test',
        })
      )

      await container.mailer.send(MESSAGE)

      expect(froms).toEqual([{ Email: 'sender@dev.test' }])
    } finally {
      await mailbox.stop(true)
    }
  })

  test.each(['dev', 'staging', 'prod'] as const)(
    'a hand-built %s Env with MAIL_LOCAL_URL set throws instead of selecting the local adapter',
    (environment) => {
      const env = {
        ...loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }),
        ENVIRONMENT: environment,
        MAIL_LOCAL_URL: 'http://evil.example.com',
      } as Env

      expect(() => createMailer(env, { warn: () => {} })).toThrow(/MAIL_LOCAL_URL/)
    }
  )

  test.each(['local', 'dev', 'staging', 'prod'] as const)(
    'a hand-built %s Env without MAIL_LOCAL_URL gets the unconfigured mailer',
    async (environment) => {
      const env = {
        ...loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }),
        ENVIRONMENT: environment,
      } as Env

      await expect(createMailer(env, { warn: () => {} }).send(MESSAGE)).rejects.toBeInstanceOf(
        MailerNotConfigured
      )
    }
  )
})

describe('turning off certificate checks (ADR 0013)', () => {
  const quiet = { warn: () => {} }
  const DEPLOYED = {
    ENVIRONMENT: 'prod',
    REGION: 'eu',
    DATABASE_URL: 'postgres://closeline_auth:x@db/closeline',
    AUTH_MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'https://auth.eu.example.com/',
    CORE_BASE_URL: 'https://core.eu.internal.example.com',
    CORE_INTERNAL_TOKEN: 'c'.repeat(32),
    SESSION_ALLOWED_ORIGINS: 'https://app.example.com',
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
  }

  /** Runs `run` with `NODE_TLS_REJECT_UNAUTHORIZED=0` set, and puts the old value back. */
  function withChecksOff<T>(run: () => T): T {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      return run()
    } finally {
      if (before === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
      }
    }
  }

  test.each(['dev', 'staging', 'prod'] as const)(
    'the service refuses to boot in %s with NODE_TLS_REJECT_UNAUTHORIZED=0, with a clear message',
    (environment) => {
      const env = loadEnv({ ...DEPLOYED, ENVIRONMENT: environment })

      const boot = () => withChecksOff(() => createContainer(env))

      expect(boot).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks/)
      // The message names the variable only: never the secret or the address of core.
      let message = ''
      try {
        boot()
      } catch (error) {
        message = String(error)
      }
      expect(message).not.toContain(DEPLOYED.CORE_INTERNAL_TOKEN)
      expect(message).not.toContain('core.eu.internal.example.com')
    }
  )

  test('local may set it (a developer machine with a self-signed certificate)', () => {
    const env = loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })

    expect(() => withChecksOff(() => createMembership(env, quiet))).not.toThrow()
  })

  test('without the variable the same deployment boots its membership client', () => {
    const env = loadEnv(DEPLOYED)

    expect(() => createMembership(env, quiet)).not.toThrow()
  })
})
