import { afterAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import {
  CORE_ERRORS,
  type CoreErrorCode,
  formatId,
  INTERNAL_CALL_ERRORS,
  type InternalCallName,
} from 'tula-closeline-contract'
import { membershipSuite } from '~/adapters/membership.suite'
import { describeError } from '~/describe-error'
import {
  MembershipBusy,
  MembershipFault,
  MembershipNotAbandonable,
  MembershipNotRetryable,
  MembershipRefused,
  MembershipUnavailable,
} from '~/ports/membership'
import { type FakeCore, type Reply, startFakeCore } from '~/testing/fake-core'
import {
  CoreCredentialsRejected,
  createHttpMembership,
  type HttpMembershipOptions,
} from './membership'

const started: FakeCore[] = []
afterAll(async () => {
  await Promise.all(started.map((core) => core.stop()))
})

const servers: Server[] = []
afterAll(() => {
  for (const server of servers) {
    server.close()
    server.closeAllConnections()
  }
})

/** The origin of a local port nothing listens on, so a call to it fails to connect. */
async function closedPortUrl(): Promise<string> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const url = `http://127.0.0.1:${server.port}`
  await server.stop(true)
  return url
}

/**
 * A stand-in core that drops the first `failures` connections without answering and then answers
 * every lookup "no membership". It counts the connections it saw.
 */
async function startFlakyCore(
  failures: number
): Promise<{ url: string; connections: () => number }> {
  let count = 0
  const server = createServer((request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/json')
    response.end('{"found":false}')
  })
  server.on('connection', (socket) => {
    count += 1
    if (count <= failures) {
      socket.destroy()
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port')
  }
  return { url: `http://127.0.0.1:${address.port}`, connections: () => count }
}

/** A fake core and an adapter pointed at it; `options` override the adapter's. */
function connect(options: Partial<HttpMembershipOptions> = {}) {
  const core = startFakeCore()
  started.push(core)
  const adapter = createHttpMembership({
    baseUrl: core.url,
    token: core.secret,
    environment: 'local',
    retryDelayMs: () => 0,
    ...options,
  })
  return { core, adapter }
}

const user = () => formatId('usr', crypto.randomUUID())
const key = () => crypto.randomUUID()
const INVITE_TOKEN = `inv-${'z'.repeat(30)}`

/** The three calls, each as a function of an adapter, for tests that treat them alike. */
const CALLS: Record<
  Exclude<InternalCallName, 'updateMemberProfile'>,
  (adapter: ReturnType<typeof connect>['adapter'], signal?: AbortSignal) => Promise<unknown>
> = {
  createOrganization: (adapter, signal) =>
    adapter.createOrganization({
      email: 'maya@northline.app',
      memberName: null,
      userId: user(),
      name: 'Northline',
      idempotencyKey: key(),
      signal,
    }),
  acceptInvitation: (adapter, signal) =>
    adapter.acceptInvitation({
      memberName: null,
      userId: user(),
      invitationToken: INVITE_TOKEN,
      email: 'rep@example.com',
      idempotencyKey: key(),
      signal,
    }),
  membership: (adapter, signal) => adapter.forUser(user(), signal),
  abandonOrganization: (adapter, signal) =>
    adapter.abandonOrganization({
      organizationId: formatId('org', crypto.randomUUID()),
      userId: user(),
      idempotencyKey: key(),
      signal,
    }),
}
const CALL_NAMES = Object.keys(CALLS) as (keyof typeof CALLS)[]

const json = (status: number, body: unknown): Reply => ({ kind: 'json', status, body })
const failure = (code: CoreErrorCode): Reply =>
  json(CORE_ERRORS[code].status, {
    error: { code, message: CORE_ERRORS[code].message },
  })

membershipSuite('http (against a fake of core)', () => {
  const { core, adapter } = connect()
  return {
    adapter,
    invite: (token, email) => core.invite(token, { email }),
    breakDown: core.breakDown,
    setStatus: core.setStatus,
    advance: core.advanceClock,
  }
})

describe('what is sent to core', () => {
  test('a create call carries the bearer secret, the idempotency key and exactly the contract body', async () => {
    const { core, adapter } = connect()
    const userId = user()
    const idempotencyKey = `signup:${crypto.randomUUID()}`

    await adapter.createOrganization({
      email: 'maya@northline.app',
      memberName: null,
      userId,
      name: '  Northline  ',
      idempotencyKey,
    })

    const [request] = core.requests
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/internal/organizations')
    expect(request?.headers.authorization).toBe(`Bearer ${core.secret}`)
    expect(request?.headers['idempotency-key']).toBe(idempotencyKey)
    expect(request?.headers['content-type']).toBe('application/json')
    expect(request?.body).toEqual({
      userId,
      organizationName: 'Northline',
      email: 'maya@northline.app',
      name: null,
    })
    expect(Object.keys(request?.headers ?? {})).not.toContain('cookie')
  })

  test('an accept call carries the user, the folded address and the raw token', async () => {
    const { core, adapter } = connect()
    core.invite(INVITE_TOKEN, { email: 'rep@example.com' })
    const userId = user()
    const idempotencyKey = key()

    await adapter.acceptInvitation({
      memberName: null,
      userId,
      invitationToken: INVITE_TOKEN,
      email: 'Rep@Example.com',
      idempotencyKey,
    })

    const [request] = core.requests
    expect(request?.path).toBe('/internal/invitations/accept')
    expect(request?.headers.authorization).toBe(`Bearer ${core.secret}`)
    expect(request?.headers['idempotency-key']).toBe(idempotencyKey)
    expect(request?.body).toEqual({
      userId,
      email: 'rep@example.com',
      name: null,
      invitationToken: INVITE_TOKEN,
    })
  })

  test('a lookup carries the secret, a valid idempotency key and only the user id', async () => {
    const { core, adapter } = connect()
    const userId = user()

    await adapter.forUser(userId)

    const [request] = core.requests
    expect(request?.path).toBe('/internal/membership')
    expect(request?.headers.authorization).toBe(`Bearer ${core.secret}`)
    expect(request?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_.:-]{16,128}$/)
    expect(request?.body).toEqual({ userId })
  })

  test('a path in the base URL is kept, and a trailing slash is not doubled', async () => {
    const { core } = connect()
    const adapter = createHttpMembership({
      baseUrl: `${core.url}/`,
      token: core.secret,
      environment: 'local',
    })

    expect(await adapter.forUser(user())).toBeNull()
    expect(core.requests[0]?.path).toBe('/internal/membership')
  })

  test('a request the contract forbids is never sent: a blank name, a malformed token, a bad key', async () => {
    const { core, adapter } = connect()

    await expect(
      adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId: user(),
        name: '   ',
        idempotencyKey: key(),
      })
    ).rejects.toMatchObject({ reason: 'organization_name_invalid' })
    await expect(
      adapter.acceptInvitation({
        memberName: null,
        userId: user(),
        invitationToken: 'short',
        email: 'a@example.com',
        idempotencyKey: key(),
      })
    ).rejects.toMatchObject({ reason: 'invitation_invalid' })
    await expect(
      adapter.createOrganization({
        email: 'maya@northline.app',
        memberName: null,
        userId: user(),
        name: 'A',
        idempotencyKey: 'too short',
      })
    ).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(0)
  })
})

describe('retries', () => {
  test('a lookup that gets a 5xx is tried once more and then succeeds', async () => {
    const { core, adapter } = connect()
    const userId = user()
    await adapter.createOrganization({
      email: 'maya@northline.app',
      memberName: null,
      userId,
      name: 'A',
      idempotencyKey: key(),
    })
    core.requests.length = 0
    core.script(json(503, { error: { code: 'server.unavailable', message: 'busy' } }))

    const found = await adapter.forUser(userId)

    expect(found?.role).toBe('owner')
    expect(core.requests).toHaveLength(2)
    expect(core.requests[1]?.headers['idempotency-key']).toBe(
      core.requests[0]?.headers['idempotency-key']
    )
  })

  test('a lookup that gets a 5xx twice gives up after two tries', async () => {
    const { core, adapter } = connect()
    core.script(json(500, {}), json(502, {}), json(503, {}))

    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(2)
  })

  test('a lookup is tried once more after a network error, and a second one is final', async () => {
    const flaky = await startFlakyCore(1)
    const dead = await startFlakyCore(Number.POSITIVE_INFINITY)
    const options = { token: 'x'.repeat(40), environment: 'local', retryDelayMs: () => 0 } as const

    expect(
      await createHttpMembership({ baseUrl: flaky.url, ...options }).forUser(user())
    ).toBeNull()
    expect(flaky.connections()).toBe(2)
    await expect(
      createHttpMembership({ baseUrl: dead.url, ...options }).forUser(user())
    ).rejects.toBeInstanceOf(MembershipUnavailable)
    expect(dead.connections()).toBe(2)
  })

  test('a lookup that times out is tried once more', async () => {
    const { core, adapter } = connect({ lookupTimeoutMs: 20 })
    core.script({ kind: 'hang' }, { kind: 'hang' })

    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(2)
  })

  test('a lookup is not retried for an answer a retry cannot change', async () => {
    const { core, adapter } = connect()
    core.script(json(400, {}), json(404, {}), json(200, { found: 'maybe' }))

    for (let i = 0; i < 3; i += 1) {
      await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)
    }

    expect(core.requests).toHaveLength(3)
  })

  test.each(['createOrganization', 'acceptInvitation'] as const)(
    '%s is tried once even when core answers 5xx or does not answer',
    async (name) => {
      const { core, adapter } = connect({ writeTimeoutMs: 20 })
      core.script(json(503, {}), { kind: 'hang' })

      await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(MembershipUnavailable)
      await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(MembershipUnavailable)

      expect(core.requests).toHaveLength(2)
    }
  )

  test('the retry pause honours the signal', async () => {
    const controller = new AbortController()
    // The warning is written just before the pause, so this aborts while the adapter is pausing
    // and no request is in flight: only the pause itself can notice.
    const { core, adapter } = connect({
      retryDelayMs: () => 60_000,
      logger: { warn: () => controller.abort() },
    })
    core.script(json(503, {}))

    await expect(adapter.forUser(user(), controller.signal)).rejects.toBeInstanceOf(
      MembershipUnavailable
    )

    expect(core.requests).toHaveLength(1)
  })
})

describe('time and the caller giving up', () => {
  test.each(CALL_NAMES)('%s stops waiting after its own bound', async (name) => {
    const { core, adapter } = connect({ lookupTimeoutMs: 20, writeTimeoutMs: 20 })
    core.script({ kind: 'hang' }, { kind: 'hang' })

    await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(MembershipUnavailable)
  })

  test.each(CALL_NAMES)(
    '%s cancels the request when the caller aborts, and does not retry',
    async (name) => {
      // Bounds far longer than the test may take, so only the abort can end the call.
      const { core, adapter } = connect({ lookupTimeoutMs: 60_000, writeTimeoutMs: 60_000 })
      core.script({ kind: 'hang' }, { kind: 'hang' })
      const controller = new AbortController()

      const pending = CALLS[name](adapter, controller.signal)
      await core.untilRequests(1)
      controller.abort()

      await expect(pending).rejects.toBeInstanceOf(MembershipUnavailable)
      await core.untilAbandoned(1)
      expect(core.requests).toHaveLength(1)
    }
  )

  test.each(CALL_NAMES)('%s with a signal already aborted sends nothing', async (name) => {
    const { core, adapter } = connect()

    await expect(CALLS[name](adapter, AbortSignal.abort())).rejects.toBeInstanceOf(
      MembershipUnavailable
    )

    expect(core.requests).toHaveLength(0)
  })
})

describe('how many calls to core are in flight', () => {
  test('a stalled core never has more calls in flight than the cap, and a full queue fails at once', async () => {
    const { core, adapter } = connect({ concurrency: 3, queue: 2 })
    core.script(...Array.from({ length: 12 }, () => ({ kind: 'hang' }) as const))
    const controllers = Array.from({ length: 8 }, () => new AbortController())

    const calls = controllers.map((controller) =>
      adapter.forUser(user(), controller.signal).then(
        () => 'answered' as const,
        (error: unknown) => error
      )
    )
    await core.untilRequests(3)
    // Three are in flight and two wait; the other three were turned away without being sent.
    const refused = await Promise.all([calls[5], calls[6], calls[7]])
    for (const error of refused) {
      expect(error).toBeInstanceOf(MembershipUnavailable)
      expect(error).toMatchObject({ name: 'CoreSaturated' })
    }
    expect(core.requests).toHaveLength(3)

    // A slot freed by a caller giving up goes to the next in line, never to a fourth at once.
    controllers[0]?.abort()
    await core.untilRequests(4)
    expect(core.requests).toHaveLength(4)

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(calls)
    // The fifth, still queued, found its caller gone and sent nothing.
    expect(core.requests).toHaveLength(4)
  })

  test('a call that waited for a slot is not retried when it is refused, and the answer is the same for every call', async () => {
    const { core, adapter } = connect({ concurrency: 1, queue: 0 })
    core.script({ kind: 'hang' })
    const controller = new AbortController()
    const stalled = adapter.forUser(user(), controller.signal).catch(() => 'aborted')
    await core.untilRequests(1)

    for (const name of CALL_NAMES) {
      await expect(CALLS[name](adapter)).rejects.toMatchObject({ name: 'CoreSaturated' })
    }

    expect(core.requests).toHaveLength(1)
    controller.abort()
    await stalled
  })
})

describe('what core can answer', () => {
  test.each(CALL_NAMES)(
    '%s: a wrong secret is a deployment fault, reported by name, not retried',
    async (name) => {
      const { core } = connect()
      const adapter = createHttpMembership({
        baseUrl: core.url,
        token: 'wrong-secret-wrong-secret-wrong-secret-0',
        environment: 'local',
      })

      const error = await CALLS[name](adapter).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(CoreCredentialsRejected)
      expect(error).toBeInstanceOf(MembershipUnavailable)
      expect(core.requests).toHaveLength(1)
      expect(JSON.stringify(describeError(error))).not.toContain('wrong-secret')
      expect(JSON.stringify(describeError(error))).not.toContain(core.secret)
    }
  )

  test.each(CALL_NAMES)('%s: a 403 is the same fault', async (name) => {
    const { core, adapter } = connect()
    core.script(failure('organization.suspended'))

    await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(CoreCredentialsRejected)
    expect(core.requests).toHaveLength(1)
  })

  test.each(CALL_NAMES)(
    '%s: a body the contract does not describe is unavailable',
    async (name) => {
      const { core, adapter } = connect()
      const bodies: Reply[] = [
        { kind: 'text', status: 200, body: 'not json at all' },
        { kind: 'text', status: 200, body: '' },
        json(200, {}),
        json(200, { organizationId: 'org_nope', role: 'owner', found: true }),
        json(200, { found: true, organizationId: formatId('org', crypto.randomUUID()) }),
        json(200, { organizationId: formatId('org', crypto.randomUUID()), role: 'emperor' }),
        json(200, [1, 2, 3]),
        json(200, null),
      ]

      for (const reply of bodies) {
        core.script(reply)
        await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(MembershipUnavailable)
      }
    }
  )

  test('an accepted Invitation cannot make the user an owner, and a lookup cannot invent a status', async () => {
    const { core, adapter } = connect()
    core.script(json(200, { organizationId: formatId('org', crypto.randomUUID()), role: 'owner' }))
    await expect(CALLS.acceptInvitation(adapter)).rejects.toBeInstanceOf(MembershipUnavailable)

    core.script(
      json(200, {
        found: true,
        organizationId: formatId('org', crypto.randomUUID()),
        role: 'rep',
        organizationStatus: 'archived',
      })
    )
    await expect(CALLS.membership(adapter)).rejects.toBeInstanceOf(MembershipUnavailable)
  })

  test('an answer that is too large is not read', async () => {
    const { core, adapter } = connect()
    core.script({
      kind: 'text',
      status: 200,
      body: `{"found":false,"pad":"${'x'.repeat(40_000)}"}`,
    })

    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)
  })

  test.each(CALL_NAMES)('%s: a redirect is not followed and not retried', async (name) => {
    const { core, adapter } = connect()
    const elsewhere = startFakeCore()
    started.push(elsewhere)
    core.script(
      { kind: 'redirect', status: 302, location: `${elsewhere.url}/internal/membership` },
      { kind: 'redirect', status: 307, location: `${elsewhere.url}/internal/membership` }
    )

    await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(1)
    expect(elsewhere.requests).toHaveLength(0)
  })

  test.each(CALL_NAMES)(
    '%s: a redirect is an error that names no secret, and its target never sees the secret',
    async (name) => {
      const { core, adapter } = connect()
      const elsewhere = startFakeCore()
      started.push(elsewhere)
      core.script({
        kind: 'redirect',
        status: 307,
        location: `${elsewhere.url}/internal/membership?secret=${core.secret}`,
      })

      const error = await CALLS[name](adapter).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(MembershipUnavailable)
      expect(`${String(error)} ${JSON.stringify(describeError(error))}`).not.toContain(core.secret)
      expect(JSON.stringify(elsewhere.requests)).not.toContain(core.secret)
      expect(elsewhere.requests).toHaveLength(0)
    }
  )

  test.each(
    CALL_NAMES.flatMap((name) =>
      (Object.keys(CORE_ERRORS) as CoreErrorCode[]).map((code) => [name, code] as const)
    )
  )('%s answered with %s', async (name, code) => {
    const { core, adapter } = connect()
    core.script(failure(code))

    const error = await CALLS[name](adapter).catch((e: unknown) => e)

    if (name === 'acceptInvitation' && code === 'invitation.invalid') {
      expect(error).toBeInstanceOf(MembershipRefused)
      expect(error).toMatchObject({ reason: 'invitation_invalid' })
    } else if (CORE_ERRORS[code].status === 403) {
      expect(error).toBeInstanceOf(CoreCredentialsRejected)
    } else if (name === 'abandonOrganization' && code === 'organization.not_abandonable') {
      expect(error).toBeInstanceOf(MembershipNotAbandonable)
    } else if (
      code === 'membership.already_member' &&
      (name === 'createOrganization' || name === 'acceptInvitation')
    ) {
      // Auth makes a fresh user id for every sign-up, so this is a fault, not an outage. (A lookup
      // is never allowed to get it, so there it is just an answer that is not believed.)
      expect(error).toBeInstanceOf(MembershipFault)
      expect(error).not.toBeInstanceOf(MembershipUnavailable)
    } else {
      expect(error).toBeInstanceOf(MembershipUnavailable)
      expect(error).not.toBeInstanceOf(MembershipRefused)
    }
  })

  test('every code the contract lists for a call is one of the codes this suite covers', () => {
    const covered = new Set(Object.keys(CORE_ERRORS))
    for (const name of CALL_NAMES) {
      for (const code of INTERNAL_CALL_ERRORS[name]) {
        expect(covered.has(code)).toBe(true)
      }
    }
  })

  test('a code core is allowed to send, with a status it does not use, is not believed', async () => {
    const { core, adapter } = connect()
    core.script(json(500, { error: { code: 'invitation.invalid', message: 'x' } }))
    core.script(json(200, { error: { code: 'invitation.invalid', message: 'x' } }))

    await expect(CALLS.acceptInvitation(adapter)).rejects.toBeInstanceOf(MembershipUnavailable)
    await expect(CALLS.acceptInvitation(adapter)).rejects.toBeInstanceOf(MembershipUnavailable)
  })

  test.each([
    [400, 'invitation.invalid'],
    [404, 'invitation.invalid'],
    [422, 'membership.already_member'],
    [500, 'invitation.invalid'],
  ] as const)(
    'a %d with the body of %s is a status core does not use for it, so the body is not believed',
    async (status, code) => {
      const { core, adapter } = connect()
      core.script(json(status, { error: { code, message: 'x' } }))
      core.script(json(status, { error: { code, message: 'x' } }))

      const accepted = await CALLS.acceptInvitation(adapter).catch((e: unknown) => e)
      const created = await CALLS.createOrganization(adapter).catch((e: unknown) => e)

      for (const error of [accepted, created]) {
        expect(error).toBeInstanceOf(MembershipUnavailable)
        expect(error).not.toBeInstanceOf(MembershipRefused)
        expect(error).not.toBeInstanceOf(MembershipFault)
      }
    }
  )

  test('a lookup names the status of a suspended and a deleted Organization', async () => {
    const { core, adapter } = connect()
    const userId = user()
    const { organizationId } = await adapter.createOrganization({
      email: 'maya@northline.app',
      memberName: null,
      userId,
      name: 'A',
      idempotencyKey: key(),
    })

    core.setStatus(organizationId, 'suspended')
    expect((await adapter.forUser(userId))?.organizationStatus).toBe('suspended')
    core.setStatus(organizationId, 'deleted')
    expect((await adapter.forUser(userId))?.organizationStatus).toBe('deleted')
  })
})

describe('what never leaves the adapter', () => {
  test('no secret, token, address or body of core appears in a log line, an error or its causes', async () => {
    const lines: string[] = []
    const { core, adapter } = connect({
      logger: { warn: (message, fields) => void lines.push(JSON.stringify({ message, fields })) },
    })
    const wrong = createHttpMembership({
      baseUrl: core.url,
      token: 'a-wrong-secret-a-wrong-secret-a-wrong-0',
      environment: 'local',
      logger: { warn: (message, fields) => void lines.push(JSON.stringify({ message, fields })) },
    })
    const address = 'private.person@example.com'
    const marker = 'BODY-MARKER-FROM-CORE'
    const echo = (status: number): Reply =>
      json(status, {
        error: {
          code: 'server.internal',
          message: `${marker} ${core.secret} ${INVITE_TOKEN} ${address}`,
        },
      })
    const errors: unknown[] = []
    const attempt = async (call: Promise<unknown>) => {
      errors.push(await call.catch((e) => e))
      core.clearScript()
    }

    for (const status of [500, 503, 400, 422, 409]) {
      core.script(echo(status), echo(status))
      await attempt(CALLS.membership(adapter))
      core.script(echo(status))
      await attempt(CALLS.createOrganization(adapter))
      core.script(echo(status))
      await attempt(
        adapter.acceptInvitation({
          memberName: null,
          userId: user(),
          invitationToken: INVITE_TOKEN,
          email: address,
          idempotencyKey: key(),
        })
      )
    }
    core.script({ kind: 'text', status: 200, body: `${marker} ${core.secret} ${address}` })
    await attempt(CALLS.membership(adapter))
    for (const name of CALL_NAMES) {
      await attempt(CALLS[name](wrong))
    }
    // A core that cannot be reached: the failure must not quote the address, the secret or the body.
    const unreachable = await closedPortUrl()
    await attempt(
      createHttpMembership({
        baseUrl: unreachable,
        token: core.secret,
        environment: 'local',
        retryDelayMs: () => 0,
        logger: { warn: (message, fields) => void lines.push(JSON.stringify({ message, fields })) },
      }).acceptInvitation({
        memberName: null,
        userId: user(),
        invitationToken: INVITE_TOKEN,
        email: address,
        idempotencyKey: key(),
      })
    )
    await attempt(
      createHttpMembership({
        baseUrl: unreachable,
        token: core.secret,
        environment: 'local',
        retryDelayMs: () => 0,
        logger: { warn: (message, fields) => void lines.push(JSON.stringify({ message, fields })) },
      }).forUser(user())
    )

    const everything = [
      ...lines,
      ...errors.map((error) => JSON.stringify(describeError(error))),
      ...errors.map((error) => String(error)),
    ].join('\n')
    expect(errors.length).toBeGreaterThan(15)
    expect(lines.length).toBeGreaterThan(0)
    for (const forbidden of [core.secret, 'a-wrong-secret', INVITE_TOKEN, address, marker]) {
      expect(everything).not.toContain(forbidden)
    }
  })

  test('the adapter object does not hold the secret where it can be enumerated or serialized', () => {
    const { core, adapter } = connect()

    expect(JSON.stringify(adapter)).not.toContain(core.secret)
    expect(Object.values(adapter).join()).not.toContain(core.secret)
  })
})

describe('what the sign-up calls carry about the person (ADR 0015)', () => {
  test('a create call sends the address and the name, and a null name when there is none', async () => {
    const { core, adapter } = connect()
    const userId = user()

    await adapter.createOrganization({
      userId,
      name: 'Northline',
      email: 'maya@northline.app',
      memberName: 'Maya Rao',
      idempotencyKey: key(),
    })
    await adapter.createOrganization({
      userId: user(),
      name: 'Northline',
      email: 'sam@northline.app',
      memberName: null,
      idempotencyKey: key(),
    })

    expect(core.requests.map((r) => r.body)).toEqual([
      { userId, organizationName: 'Northline', email: 'maya@northline.app', name: 'Maya Rao' },
      expect.objectContaining({ email: 'sam@northline.app', name: null }),
    ])
  })

  test('a create call whose address the contract refuses is not sent', async () => {
    const { core, adapter } = connect()

    await expect(
      adapter.createOrganization({
        userId: user(),
        name: 'Northline',
        email: 'not an address',
        memberName: null,
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(0)
  })

  test('an accept call sends the name beside the address', async () => {
    const { core, adapter } = connect()
    core.invite(INVITE_TOKEN, { email: 'rep@example.com' })

    await adapter.acceptInvitation({
      userId: user(),
      invitationToken: INVITE_TOKEN,
      email: 'rep@example.com',
      memberName: 'Rae Pell',
      idempotencyKey: key(),
    })

    expect(core.requests[0]?.body).toMatchObject({ name: 'Rae Pell', email: 'rep@example.com' })
  })
})

describe('a large error page is never read, as before the kit client', () => {
  const page = (bytes: number) => ({ kind: 'text', status: 0, body: 'x'.repeat(bytes) }) as const
  const big = (status: number, bytes: number): Reply => ({ ...page(bytes), status })

  test('a lookup answered 503 with a 20 KiB body is attempted twice', async () => {
    const { core, adapter } = connect()
    core.script(big(503, 20_480), big(503, 20_480), big(503, 20_480))

    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(2)
  })

  test.each(CALL_NAMES)('%s: a 401 with a 20 KiB body is the rejected secret', async (name) => {
    const { core, adapter } = connect()
    core.script(big(401, 20_480))

    await expect(CALLS[name](adapter)).rejects.toBeInstanceOf(CoreCredentialsRejected)
  })

  test('an abandon answered 503 with a 20 KiB body is busy', async () => {
    const { core, adapter } = connect()
    core.script(big(503, 20_480))

    await expect(CALLS.abandonOrganization(adapter)).rejects.toBeInstanceOf(MembershipBusy)
  })

  test('a 5xx with a 100 KiB body is still bounded and still retried once', async () => {
    const { core, adapter } = connect()
    core.script(big(502, 100_000), big(502, 100_000))

    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(2)
  })

  test('a 200 with a 100 KiB body, and one with 20 KiB, are not believed', async () => {
    const { core, adapter } = connect()
    core.script(big(200, 100_000), {
      kind: 'text',
      status: 200,
      body: `{"found":false,"pad":"${'x'.repeat(20_000)}"}`,
    })

    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)
    await expect(adapter.forUser(user())).rejects.toBeInstanceOf(MembershipUnavailable)
    expect(core.requests).toHaveLength(2)
  })
})

describe('abandoning an Organization', () => {
  const organizationId = () => formatId('org', crypto.randomUUID())

  test('the request is one POST to the Organization with the user id, the secret and the key', async () => {
    const { core, adapter } = connect()
    const org = organizationId()
    const userId = user()
    const idempotencyKey = `abandon:${crypto.randomUUID()}`

    await adapter.abandonOrganization({ organizationId: org, userId, idempotencyKey })

    expect(core.requests).toHaveLength(1)
    const [request] = core.requests
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe(`/internal/organizations/${org}/abandon`)
    expect(request?.headers.authorization).toBe(`Bearer ${core.secret}`)
    expect(request?.headers['idempotency-key']).toBe(idempotencyKey)
    expect(request?.body).toEqual({ userId })
  })

  test('200 is done, whether or not the Organization ever existed', async () => {
    const { adapter } = connect()

    await expect(
      adapter.abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
    ).resolves.toBeUndefined()
  })

  test('409 not_abandonable is a refusal that is not an outage', async () => {
    const { core, adapter } = connect()
    core.script(failure('organization.not_abandonable'))

    const error = await adapter
      .abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MembershipNotAbandonable)
    expect(error).not.toBeInstanceOf(MembershipUnavailable)
  })

  test('503 is busy and carries the whole-second Retry-After, uncapped; any other form is none', async () => {
    const { core, adapter } = connect()
    const input = () => ({
      organizationId: organizationId(),
      userId: user(),
      idempotencyKey: key(),
    })
    core.script(
      { kind: 'json', status: 503, body: {}, headers: { 'retry-after': '2' } },
      { kind: 'json', status: 503, body: {}, headers: { 'retry-after': '9999' } },
      { kind: 'json', status: 503, body: {}, headers: { 'retry-after': 'soon' } }
    )

    const asked = await adapter.abandonOrganization(input()).catch((e: unknown) => e)
    const huge = await adapter.abandonOrganization(input()).catch((e: unknown) => e)
    const junk = await adapter.abandonOrganization(input()).catch((e: unknown) => e)

    // The adapter passes core's number on; the abandon loop caps the pause (`ABANDON_MAX_PAUSE_MS`).
    for (const outcome of [asked, huge, junk]) {
      expect(outcome).toBeInstanceOf(MembershipBusy)
    }
    expect(asked).toMatchObject({ retryAfterMs: 2_000 })
    expect(huge).toMatchObject({ retryAfterMs: 9_999_000 })
    expect(junk).toMatchObject({ retryAfterMs: undefined })
    expect(core.requests).toHaveLength(3)
  })

  test('a timeout is unavailable, and the request is sent once', async () => {
    const { core, adapter } = connect({ writeTimeoutMs: 20 })
    core.script({ kind: 'hang' })

    await expect(
      adapter.abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(1)
  })

  test.each([
    ['a body that is not JSON', { kind: 'text', status: 200, body: 'ok' } as const],
    ['a status other than deleted', json(200, { organizationId: 'x', status: 'active' })],
    ['an empty object', json(200, {})],
  ])('%s is unavailable', async (_name, reply) => {
    const { core, adapter } = connect()
    core.script(reply)

    await expect(
      adapter.abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(MembershipUnavailable)
  })

  test('an answer about another Organization is not believed', async () => {
    const { core, adapter } = connect()
    core.script(json(200, { organizationId: organizationId(), status: 'deleted' }))

    await expect(
      adapter.abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(MembershipUnavailable)
  })

  test('an Organization id that is not one is never put in a path', async () => {
    const { core, adapter } = connect()

    await expect(
      adapter.abandonOrganization({
        organizationId: '../x' as ReturnType<typeof organizationId>,
        userId: user(),
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(MembershipUnavailable)

    expect(core.requests).toHaveLength(0)
  })

  test.each([
    [400, json(400, { error: { code: 'request.invalid', message: 'x' } })],
    [404, json(404, { error: { code: 'request.not_found', message: 'x' } })],
    [422, json(422, {})],
    [409, json(409, { error: { code: 'membership.already_member', message: 'x' } })],
  ])('a %s is not retryable', async (_status, reply) => {
    const { core, adapter } = connect()
    core.script(reply)

    const error = await adapter
      .abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MembershipNotRetryable)
  })

  test.each([500, 502, 504])('a %s stays retryable', async (status) => {
    const { core, adapter } = connect()
    core.script({ kind: 'text', status, body: 'down' })

    const error = await adapter
      .abandonOrganization({
        organizationId: organizationId(),
        userId: user(),
        idempotencyKey: key(),
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MembershipUnavailable)
    expect(error).not.toBeInstanceOf(MembershipNotRetryable)
  })
})
