import { expect, test } from 'bun:test'
import { createContainer, reportSafely } from './container'
import { loadEnv } from './env'

test('the default reportError logs the failure with its request context at error level', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
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
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
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
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
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
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }))
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
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local' }), {
    logDestination: { write: (l) => lines.push(l) },
  })
  const requestId = `req_${'b'.repeat(32)}` as never

  container.reportError('password=hunter2', { requestId, method: 'GET', path: '/x', status: 500 })

  expect(lines[0]).not.toContain('hunter2')
})

test('LOG_LEVEL silences the logger', () => {
  const lines: string[] = []
  const container = createContainer(loadEnv({ ENVIRONMENT: 'local', LOG_LEVEL: 'silent' }), {
    logDestination: { write: (l) => lines.push(l) },
  })

  container.logger.error('nothing to see')

  expect(lines).toHaveLength(0)
})

test('a container built from the environment has no readiness checks yet', () => {
  expect(createContainer(loadEnv({ ENVIRONMENT: 'local' })).readinessChecks).toEqual([])
})
