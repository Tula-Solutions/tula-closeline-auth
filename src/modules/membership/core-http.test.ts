import { afterAll, describe, expect, test } from 'bun:test'
import { CORE_ERRORS } from 'tula-closeline-contract'
import { createHttpMembership } from '~/adapters/http/membership'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { call, emailedCode, text, wrongCode } from '~/testing/client'
import { type FakeCore, startFakeCore } from '~/testing/fake-core'

/*
 * The membership adapter over HTTP, against a fake of core, driven through auth's own routes:
 * what a sign-up costs the person while core is down, what a fault in core looks like, and how
 * often a stream of failures reaches the error tracker.
 */

const PASSWORD = 'correct horse battery'
const EMAIL = 'maya@northline.app'

const started: FakeCore[] = []
afterAll(async () => {
  await Promise.all(started.map((core) => core.stop()))
})

async function setup() {
  const core = startFakeCore()
  started.push(core)
  const adapter = (token = core.secret) =>
    createHttpMembership({ baseUrl: core.url, token, retryDelayMs: () => 0 })
  const base = await createReadyDeps()
  // The same container with the real adapter in place of the memory one; the logs, the reports
  // and the clock are the ones `base` records.
  const deps = { ...base, membership: adapter() }
  const app = createApp(deps)
  const started1 = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'ios',
    body: { email: EMAIL, password: PASSWORD, organizationName: 'Northline' },
  })
  const verify = (code = emailedCode(base, EMAIL)) =>
    call(app, 'POST', `/v1/client/sign-ups/${text(started1.body, 'id')}/verify-email`, {
      attempt: text(started1.body, 'attemptSecret'),
      body: { code },
    })
  return { core, adapter, base, deps, app, verify }
}

/** The warn-level log lines (pino level 40) whose message is the outage line, as parsed JSON. */
const outageWarnings = (lines: string[]) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((l) => l.level === 40 && l.msg === 'membership is unavailable')

describe('a sign-up while core is down', () => {
  test('five verifications during an outage do not use up the code: it works once core is back', async () => {
    const { core, verify } = await setup()
    core.breakDown(true)

    for (let n = 0; n < 5; n++) {
      expect((await verify()).status).toBe(503)
    }
    core.breakDown(false)
    const done = await verify()

    expect(done.status).toBe(200)
  })

  test('a core that cannot be asked in time gives the try back as well', async () => {
    const { core, verify } = await setup()
    core.script(
      ...Array.from({ length: 6 }, () => ({ kind: 'json', status: 500, body: {} }) as const)
    )

    for (let n = 0; n < 6; n++) {
      expect((await verify()).status).toBe(503)
    }

    expect((await verify()).status).toBe(200)
  })

  test('a wrong code is still counted, and an outage does not hide the limit', async () => {
    const { core, base, deps, verify } = await setup()
    const wrong = wrongCode(emailedCode(base, EMAIL))
    core.breakDown(true)
    for (let n = 0; n < 3; n++) {
      expect((await verify()).status).toBe(503)
    }
    core.breakDown(false)

    // Five wrong codes in a row use up the code however many outages came before.
    for (let n = 0; n < 5; n++) {
      expect((await verify(wrong)).status).toBe(422)
    }
    expect(await verify()).toMatchObject({
      status: 429,
      body: { error: { code: 'verification.too_many_attempts' } },
    })
    expect(deps.reported).toHaveLength(0)
  })
})

describe('core says the user already belongs to an Organization', () => {
  test('it is a fault, not an outage: 500 without Retry-After, reported once, and the try stays spent', async () => {
    const { core, deps, verify } = await setup()
    const fault = {
      kind: 'json',
      status: CORE_ERRORS['membership.already_member'].status,
      body: {
        error: {
          code: 'membership.already_member',
          message: CORE_ERRORS['membership.already_member'].message,
        },
      },
    } as const
    core.script(fault, fault, fault, fault, fault)

    const replies = []
    for (let n = 0; n < 5; n++) {
      replies.push(await verify())
    }
    const sixth = await verify()

    for (const reply of replies) {
      expect(reply.status).toBe(500)
      expect(reply.body).toMatchObject({ error: { code: 'server.internal' } })
      expect(reply.headers.get('retry-after')).toBeNull()
    }
    expect(sixth.status).toBe(429)
    expect(deps.reported).toHaveLength(1)
    expect(
      JSON.stringify(
        deps.reported[0]?.error,
        Object.getOwnPropertyNames(deps.reported[0]?.error ?? {})
      )
    ).not.toContain(EMAIL)
  })
})

describe('how often a failing core reaches the error tracker', () => {
  async function signedIn() {
    const context = await setup()
    const done = await context.verify()
    expect(done.status).toBe(200)
    return { ...context, refreshToken: text(done.body, 'session.refreshToken') }
  }

  test('a rejected shared secret is logged every time but reported at most once a minute', async () => {
    const { deps, app, adapter, refreshToken } = await signedIn()
    deps.membership = adapter('wrong-secret-wrong-secret-wrong-secret-0')

    let last = 0
    for (let n = 0; n < 100; n++) {
      const reply = await call(app, 'POST', '/v1/client/sessions/refresh', {
        body: { refreshToken },
      })
      last = reply.status
    }

    expect(last).toBe(503)
    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.error).toMatchObject({ cause: { name: 'CoreCredentialsRejected' } })
    expect(outageWarnings(deps.logLines)).toHaveLength(100)
    expect(outageWarnings(deps.logLines)[0]).toMatchObject({ cause: 'CoreCredentialsRejected' })

    deps.clock.advance('61s')
    await call(app, 'POST', '/v1/client/sessions/refresh', { body: { refreshToken } })
    expect(deps.reported).toHaveLength(2)
  })

  test('an outage is logged at warn with its cause and is not reported at all', async () => {
    const { core, deps, app, refreshToken } = await signedIn()
    core.breakDown(true)

    for (let n = 0; n < 100; n++) {
      const reply = await call(app, 'POST', '/v1/client/sessions/refresh', {
        body: { refreshToken },
      })
      expect(reply.status).toBe(503)
      expect(reply.headers.get('retry-after')).toBe('5')
    }

    expect(deps.reported).toHaveLength(0)
    expect(outageWarnings(deps.logLines)).toHaveLength(100)
    expect(outageWarnings(deps.logLines)[0]).toMatchObject({ cause: 'MembershipUnavailable' })
  })
})

describe('an Organization abandoned over HTTP after the account failed to write', () => {
  /** Reports about an Organization left without an owner (the 500 itself is reported too). */
  const orphanReports = (base: { reported: { error: unknown }[] }) =>
    base.reported.filter(
      (entry) => entry.error instanceof Error && entry.error.message.includes('reconcile')
    )
  const abandonRequests = (core: FakeCore) =>
    core.requests.filter((request) => request.path.endsWith('/abandon'))

  test('sign-up sends core the address and name, and a failed account write abandons the Organization it made', async () => {
    const { core, base, verify } = await setup()
    base.users.create = async () => {
      throw new Error('connection reset')
    }

    const failed = await verify()

    expect(failed.status).toBe(500)
    const [create] = core.requests
    expect(create?.path).toBe('/internal/organizations')
    expect(create?.body).toMatchObject({ email: EMAIL, name: null })
    const [abandon] = abandonRequests(core)
    expect(abandonRequests(core)).toHaveLength(1)
    expect(abandon?.headers['idempotency-key']).toStartWith('abandon:')
    expect(abandon?.headers.authorization).toBe(`Bearer ${core.secret}`)
    expect(abandon?.body).toEqual({ userId: expect.stringMatching(/^usr_/) })
    expect(orphanReports(base)).toHaveLength(0)
  })

  test('core refusing the abandon (409) is reported once and the answer is still the 500', async () => {
    const { core, base, verify } = await setup()
    base.users.create = async () => {
      throw new Error('connection reset')
    }
    // Scripted answers go to the next requests in order: the create, then the abandon.
    core.script(
      {
        kind: 'json',
        status: 200,
        body: { organizationId: `org_${'a'.repeat(32)}`, role: 'owner' },
      },
      {
        kind: 'json',
        status: 409,
        body: { error: { code: 'organization.not_abandonable', message: 'no' } },
      }
    )

    const failed = await verify()

    expect(failed.status).toBe(500)
    expect(abandonRequests(core)).toHaveLength(1)
    expect(orphanReports(base)).toHaveLength(1)
    const everything = JSON.stringify([base.logLines, base.reported.map((r) => String(r.error))])
    expect(everything).toContain(`org_${'a'.repeat(32)}`)
    expect(everything).not.toContain(EMAIL)
    expect(everything).not.toContain(core.secret)
  })

  test('busy twice then done: three requests, one key, no report', async () => {
    const { core, base, verify } = await setup()
    base.users.create = async () => {
      throw new Error('connection reset')
    }
    const org = `org_${'b'.repeat(32)}`
    core.script(
      { kind: 'json', status: 200, body: { organizationId: org, role: 'owner' } },
      { kind: 'json', status: 503, body: {}, headers: { 'retry-after': '0' } },
      { kind: 'json', status: 503, body: {}, headers: { 'retry-after': '0' } },
      { kind: 'json', status: 200, body: { organizationId: org, status: 'deleted' } }
    )

    const failed = await verify()

    expect(failed.status).toBe(500)
    const sent = abandonRequests(core)
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map((r) => r.headers['idempotency-key'])).size).toBe(1)
    expect(orphanReports(base)).toHaveLength(0)
  })
})
