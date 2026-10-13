import { describe, expect, spyOn, test } from 'bun:test'
import type { UserId } from 'tula-closeline-contract'
import { createApp } from '~/app'
import * as Abandon from '~/modules/abandon/service'
import * as Bootstrap from '~/modules/bootstrap/service'
import { createReadyDeps, type TestDeps } from '~/testing'
import { call, emailedCode, text } from '~/testing/client'

const PASSWORD = 'correct horse battery'

async function setup() {
  const deps = await createReadyDeps()
  const app = createApp(deps)
  const tenant = Bootstrap.requireTenant(deps)
  let n = 0
  const start = async (extra: Record<string, unknown> = { organizationName: 'Northline' }) => {
    const email = `maya${++n}@northline.app`
    const started = await call(app, 'POST', '/v1/client/sign-ups', {
      client: 'ios',
      body: { email, password: PASSWORD, ...extra },
    })
    return { email, started, code: emailedCode(deps, email) }
  }
  const verify = (started: { body: unknown }, code: string) =>
    call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      attempt: text(started.body, 'attemptSecret'),
      body: { code },
    })
  /** A sign-up whose account insert fails after core has made the Organization (a crash). */
  const crashed = async () => {
    const { email, started, code } = await start()
    const create = deps.users.create.bind(deps.users)
    deps.users.create = async () => {
      throw new Error('connection reset')
    }
    const reply = await verify(started, code)
    deps.users.create = create
    return { email, started, code, reply, caseId: text(started.body, 'id') }
  }
  const pastGrace = () => deps.clock.advance('11m')
  const only = () => {
    const [one] = deps.abandonCases.cases
    if (!one) {
      throw new Error('no abandon case')
    }
    return one
  }
  return { deps, app, tenant, start, verify, crashed, pastGrace, only }
}

const sweepOnce = (deps: TestDeps, tenant: ReturnType<typeof Bootstrap.requireTenant>) =>
  Abandon.sweep(deps, tenant)
/** The sweep's own reports (the request's report of the same orphan is a different one). */
const reconciles = (deps: TestDeps) =>
  deps.reported.filter(
    (entry) =>
      entry.context.method === 'ABANDON' &&
      entry.error instanceof Error &&
      entry.error.message.includes('reconcile')
  )

describe('the abandon sweep', () => {
  test('a crash after core answers and before the account insert ends with the Organization abandoned', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    const { reply, caseId } = await crashed()
    expect(reply.status).toBe(500)
    expect(only().outcome).toBeNull()

    // Not due while the attempt can still write an account, nor during the grace after it.
    expect(await sweepOnce(deps, tenant)).toMatchObject({ abandoned: 0 })
    deps.clock.advance('10m')
    expect(await sweepOnce(deps, tenant)).toMatchObject({ abandoned: 0 })
    expect(deps.membership.calls.abandon).toBe(0)

    pastGrace()
    const result = await sweepOnce(deps, tenant)

    expect(result.abandoned).toBe(1)
    const org = deps.membership.organizations[0]
    expect(deps.membership.abandons).toEqual([
      {
        organizationId: String(org?.organizationId),
        userId: org?.owner as UserId,
        idempotencyKey: `abandon:${caseId}`,
      },
    ])
    expect(only().outcome).toBe('done')
    expect(await deps.membership.forUser(org?.owner as never)).toBeNull()
  })

  test('the case is recorded before core is asked, and learns the Organization id after', async () => {
    const { deps, start, verify, only } = await setup()
    const { started, code } = await start()
    let seenBefore: unknown
    const create = deps.membership.createOrganization.bind(deps.membership)
    deps.membership.createOrganization = async (input) => {
      seenBefore = { ...only() }
      return create(input)
    }

    const done = await verify(started, code)

    expect(done.status).toBe(200)
    expect(seenBefore).toMatchObject({ organizationId: null, outcome: null })
    expect(only().organizationId).toBe(deps.membership.organizations[0]?.organizationId ?? 'none')
  })

  test('a committed account resolves its case in the same step and is never abandoned', async () => {
    const { deps, tenant, start, verify, pastGrace, only } = await setup()
    const { started, code } = await start()

    const done = await verify(started, code)
    expect(done.status).toBe(200)
    expect(only().outcome).toBe('done')
    pastGrace()
    const result = await sweepOnce(deps, tenant)

    expect(result).toMatchObject({ abandoned: 0, account_exists: 0 })
    expect(deps.membership.calls.abandon).toBe(0)
  })

  test('a double submit whose second request commits is never abandoned', async () => {
    const { deps, tenant, start, verify, pastGrace, only } = await setup()
    const { started, code } = await start()
    const create = deps.users.create.bind(deps.users)
    deps.users.create = async () => {
      throw new Error('connection reset')
    }
    const first = await verify(started, code)
    deps.users.create = create
    expect(first.status).toBe(500)
    expect(only().outcome).toBeNull()

    const second = await verify(started, code)
    pastGrace()
    const result = await sweepOnce(deps, tenant)

    expect(second.status).toBe(200)
    expect(result.abandoned).toBe(0)
    expect(deps.membership.calls.abandon).toBe(0)
    expect(only().outcome).toBe('done')
  })

  test('an account that commits just before the attempt expires, without resolving the case, is still never abandoned', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    const { email, started } = await crashed()
    const attempt = await deps.flowAttempts.findById(tenant.environmentId, text(started.body, 'id'))
    // The second submit's account lands one second before the attempt expires.
    deps.clock.advance('599s')
    await deps.users.create({
      id: String(attempt?.state.userId),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: crypto.randomUUID(),
      credentialId: crypto.randomUUID(),
      passwordHash: '$argon2id$mine',
    })
    expect(only().outcome).toBeNull()
    pastGrace()

    const result = await sweepOnce(deps, tenant)

    expect(result.account_exists).toBe(1)
    expect(deps.membership.calls.abandon).toBe(0)
    expect(only().outcome).toBe('done')
  })

  test('a refusal (409) resolves the case as refused and is reported once, by ids', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    const { email } = await crashed()
    deps.membership.refuseAbandons(true)
    pastGrace()

    const first = await sweepOnce(deps, tenant)
    deps.clock.advance('1h')
    const second = await sweepOnce(deps, tenant)

    expect(first.refused).toBe(1)
    expect(second.refused).toBe(0)
    expect(only().outcome).toBe('refused')
    expect(deps.membership.calls.abandon).toBe(1)
    const sweepReports = reconciles(deps)
    expect(sweepReports).toHaveLength(1)
    const message = String(sweepReports[0]?.error)
    expect(message).toContain(deps.membership.organizations[0]?.organizationId ?? 'none')
    expect(message).not.toContain(email)
    expect(deps.logLines.join('\n')).not.toContain(email)
  })

  test('a busy core (503) leaves the case for its next lease, and the next run succeeds', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    await crashed()
    deps.membership.failNextAbandons(3)
    pastGrace()

    const first = await sweepOnce(deps, tenant)
    const during = await sweepOnce(deps, tenant)

    expect(first.retry_later).toBe(1)
    expect(only().outcome).toBeNull()
    expect(only().attempts).toBe(1)
    // The lease still holds: nobody calls core again until it ends.
    expect(during.retry_later).toBe(0)
    expect(deps.membership.calls.abandon).toBe(3)

    deps.clock.advance(`${Abandon.leaseMs(10) + 1000}ms`)
    const next = await sweepOnce(deps, tenant)

    expect(next.abandoned).toBe(1)
    expect(only().outcome).toBe('done')
    expect(only().attempts).toBe(2)
  })

  test('a case whose Organization id was never learned is found by its user and abandoned', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    // The answer of core was made but its id never reached the case.
    const learn = spyOn(deps.abandonCases, 'learn').mockRejectedValue(new Error('connection reset'))
    await crashed()
    learn.mockRestore()
    expect(only().organizationId).toBeNull()
    pastGrace()

    const result = await sweepOnce(deps, tenant)

    expect(result.abandoned).toBe(1)
    expect(deps.membership.abandons[0]?.organizationId).toBe(
      deps.membership.organizations[0]?.organizationId ?? 'none'
    )
  })

  test('an unlearned case where core made nothing is resolved without an abandon call', async () => {
    const { deps, tenant, start, verify, pastGrace, only } = await setup()
    const { started, code } = await start()
    deps.membership.breakDown(true)
    expect((await verify(started, code)).status).toBe(503)
    expect(only().organizationId).toBeNull()
    pastGrace()

    // Core still down: the lookup cannot answer, so the case waits.
    const waiting = await sweepOnce(deps, tenant)
    expect(waiting.retry_later).toBe(1)
    expect(only().outcome).toBeNull()

    deps.membership.breakDown(false)
    deps.clock.advance(`${Abandon.leaseMs(10) + 1000}ms`)
    const result = await sweepOnce(deps, tenant)

    expect(result.no_organization).toBe(1)
    expect(deps.membership.calls.abandon).toBe(0)
    expect(only().outcome).toBe('done')
  })

  test('a case that keeps failing is given up and reported by ids', async () => {
    const { deps, tenant, start, verify, pastGrace, only } = await setup()
    const { started, code } = await start()
    deps.membership.breakDown(true)
    await verify(started, code)
    pastGrace()

    for (let run = 0; run < Abandon.ABANDON_SWEEP_MAX_ATTEMPTS; run += 1) {
      expect((await sweepOnce(deps, tenant)).retry_later).toBe(1)
      deps.clock.advance(`${Abandon.leaseMs(10) + 1000}ms`)
    }
    const last = await sweepOnce(deps, tenant)

    expect(last.gave_up).toBe(1)
    expect(only().outcome).toBe('gave_up')
    expect(reconciles(deps)).toHaveLength(1)
  })

  test('a case that used every try the table allows is given up by the safety net', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    await crashed()
    pastGrace()
    for (let claim = 0; claim < 100; claim += 1) {
      await deps.abandonCases.claim(tenant.environmentId, 1, 1_000)
      deps.clock.advance('2s')
    }
    expect(only().attempts).toBe(100)

    const result = await sweepOnce(deps, tenant)

    expect(result.spent).toBe(1)
    expect(only().outcome).toBe('gave_up')
    expect(deps.membership.calls.abandon).toBe(0)
    expect(reconciles(deps)).toHaveLength(1)
  })

  test('two sweeps at once take different cases and core is called once for each', async () => {
    const { deps, tenant, crashed, pastGrace } = await setup()
    for (let i = 0; i < 6; i += 1) {
      await crashed()
    }
    pastGrace()
    const small = { ...deps, env: { ...deps.env, ABANDON_SWEEP_BATCH_SIZE: 2 } }

    const results = await Promise.all([
      Abandon.sweep(small, tenant),
      Abandon.sweep(small, tenant),
      Abandon.sweep(small, tenant),
    ])

    expect(results.reduce((sum, result) => sum + result.abandoned, 0)).toBe(6)
    const keys = deps.membership.abandons.map((entry) => entry.idempotencyKey)
    expect(keys).toHaveLength(6)
    expect(new Set(keys).size).toBe(6)
  })

  test('two runs at once under the lock: one sweeps, the other skips', async () => {
    const { deps, tenant } = await setup()
    let inner: Abandon.RunOutcome | undefined

    const held = await deps.exclusive.runExclusive(Abandon.ABANDON_SWEEP_LOCK, async () => {
      inner = await Abandon.runOnce(deps, tenant)
    })

    expect(held).toBe(true)
    expect(inner).toBe('skipped')
    expect(await Abandon.runOnce(deps, tenant)).toBe('swept')
  })

  test('a case the lease was lost on is not an error when its answer arrives', async () => {
    const { deps, tenant, crashed, pastGrace, only } = await setup()
    await crashed()
    pastGrace()
    // Another worker resolves the case while this one is calling core.
    const abandonOrganization = deps.membership.abandonOrganization.bind(deps.membership)
    deps.membership.abandonOrganization = async (input) => {
      await abandonOrganization(input)
      await deps.abandonCases.resolve(tenant.environmentId, only().id, 'gave_up')
    }

    const result = await sweepOnce(deps, tenant)

    expect(result.lost_lease).toBe(1)
    expect(reconciles(deps)).toHaveLength(0)
  })
})

describe('recording a sign-up', () => {
  test('nothing is created at core when the case cannot be recorded', async () => {
    const { deps, start, verify } = await setup()
    const { started, code } = await start()
    spyOn(deps.abandonCases, 'record').mockRejectedValue(new Error('connection reset'))

    const reply = await verify(started, code)

    expect(reply.status).toBe(500)
    expect(deps.membership.calls.create).toBe(0)
  })

  test('an invitation sign-up is never recorded', async () => {
    const { deps, start, verify } = await setup()
    const organizationId = `org_${'a'.repeat(32)}`
    const email = 'maya0@northline.app'
    deps.membership.invite('inv-1', { email, organizationId, role: 'rep' })
    const started = await call(createApp(deps), 'POST', '/v1/client/sign-ups', {
      client: 'ios',
      body: { email, password: PASSWORD, invitationToken: 'inv-1' },
    })

    const done = await verify(started, emailedCode(deps, email))

    expect(done.status).toBe(200)
    expect(deps.abandonCases.cases).toHaveLength(0)
    void start
  })

  test('a case that finds an Organization another case holds is given up and reported', async () => {
    const { deps, start, verify, only } = await setup()
    const { started, code } = await start()
    spyOn(deps.abandonCases, 'learn').mockResolvedValue('conflict')

    const done = await verify(started, code)

    expect(done.status).toBe(200)
    expect(only().outcome).toBe('gave_up')
    expect(reconciles(deps)).toHaveLength(0)
    expect(
      deps.reported.some((entry) => String(entry.error).includes('another case already holds'))
    ).toBe(true)
  })
})

describe('the in-request abandon and its case', () => {
  const lose = (
    deps: TestDeps,
    email: string,
    tenant: ReturnType<typeof Bootstrap.requireTenant>
  ) => {
    const create = deps.membership.createOrganization.bind(deps.membership)
    deps.membership.createOrganization = async (input) => {
      const created = await create(input)
      await deps.users.create({
        id: crypto.randomUUID(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email,
        emailNormalized: email,
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: crypto.randomUUID(),
        credentialId: crypto.randomUUID(),
        passwordHash: '$argon2id$rival',
      })
      return created
    }
  }

  test('resolves its case when core says the Organization is gone', async () => {
    const { deps, tenant, start, verify, pastGrace, only } = await setup()
    const { email, started, code } = await start()
    lose(deps, email, tenant)

    const lost = await verify(started, code)
    pastGrace()
    const result = await sweepOnce(deps, tenant)

    expect(lost.status).toBe(409)
    expect(only().outcome).toBe('done')
    expect(deps.membership.calls.abandon).toBe(1)
    expect(result).toMatchObject({ abandoned: 0, account_exists: 0 })
  })

  test('resolves its case as refused when core refuses', async () => {
    const { deps, tenant, start, verify, only } = await setup()
    const { email, started, code } = await start()
    lose(deps, email, tenant)
    deps.membership.refuseAbandons(true)

    await verify(started, code)

    expect(only().outcome).toBe('refused')
  })

  test('leaves its case open for the sweep when core could not be asked', async () => {
    const { deps, tenant, start, verify, pastGrace, only } = await setup()
    const { email, started, code } = await start()
    lose(deps, email, tenant)
    deps.membership.failNextAbandons(3)

    await verify(started, code)
    expect(only().outcome).toBeNull()
    pastGrace()
    const result = await sweepOnce(deps, tenant)

    expect(result.abandoned).toBe(1)
    expect(only().outcome).toBe('done')
  })
})
