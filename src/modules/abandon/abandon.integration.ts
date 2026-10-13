import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { withEnvironment } from 'tula-closeline-db'
import { createApp } from '~/app'
import * as Bootstrap from '~/modules/bootstrap/service'
import { AbandonCaseClaimed } from '~/ports/user-repository'
import { call, emailedCode, text } from '~/testing/client'
import { ownerPool } from '~/testing/postgres'
import { createPostgresDeps } from '~/testing/postgres-deps'
import * as Abandon from './service'

const PASSWORD = 'correct horse battery'

let deps: Awaited<ReturnType<typeof createPostgresDeps>>
let owner: Pool
let n = 0

beforeAll(async () => {
  deps = await createPostgresDeps()
  owner = ownerPool()
})
afterAll(async () => {
  await owner.end()
  await deps.stop()
})
beforeEach(async () => {
  // TRUNCATE is not subject to row-level security. A DELETE would not do: the restrictive
  // delete policy lets even the owner remove resolved rows only, so open cases would leak.
  await owner.query('truncate table auth.abandon_cases')
})

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

/** Runs statements as the owner with the environment set (forced row-level security binds it too). */
async function inEnvironment<T>(
  pool: Pool,
  environmentId: string,
  run: (query: Query) => Promise<T>
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('select set_config($1, $2, true)', ['tula.environment_id', environmentId])
    const result = await run((text, values) => client.query(text, values))
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/** Moves every open case's expiry and due time back, as time passing does (the database decides). */
async function age(seconds: number): Promise<void> {
  const tenant = Bootstrap.requireTenant(deps)
  await inEnvironment(owner, tenant.environmentId, (query) =>
    query(
      `update auth.abandon_cases
          set attempt_expires_at = attempt_expires_at - make_interval(secs => $1::float8),
              next_attempt_at = next_attempt_at - make_interval(secs => $1::float8)
        where resolved_at is null`,
      [seconds]
    )
  )
}

const FAR = 3_600

/**
 * The service stamps a case with the attempt's expiry from its own clock, which in these tests is
 * the fixed one (January 2026), so by the database's clock every case would be due at once.
 * Re-stamps the case as a real clock would have: the attempt expires in 10 minutes, plus grace.
 */
async function onDatabaseClock(caseId: string): Promise<void> {
  const tenant = Bootstrap.requireTenant(deps)
  await inEnvironment(owner, tenant.environmentId, (query) =>
    query(
      `update auth.abandon_cases
          set attempt_expires_at = clock_timestamp() + interval '10 minutes',
              next_attempt_at = clock_timestamp() + interval '10 minutes'
                                + make_interval(secs => $2::float8 / 1000)
        where id = $1`,
      [caseId, Abandon.ABANDON_GRACE_MS]
    )
  )
}

async function cases(): Promise<Record<string, unknown>[]> {
  const tenant = Bootstrap.requireTenant(deps)
  const result = await withEnvironment(deps.db, tenant.environmentId, (tx) =>
    tx.execute(
      sql`select id, core_organization_id, outcome, attempts, resolved_at from auth.abandon_cases order by created_at`
    )
  )
  return result.rows as Record<string, unknown>[]
}

async function start() {
  const app = createApp(deps)
  const email = `maya${++n}@northline.app`
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'ios',
    body: { email, password: PASSWORD, organizationName: 'Northline' },
  })
  const verify = () =>
    call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    })
  return { email, started, verify }
}

/** A sign-up whose account insert fails after core has made the Organization. */
async function crash() {
  const one = await start()
  const create = deps.users.create.bind(deps.users)
  deps.users.create = async () => {
    throw new Error('connection reset')
  }
  const reply = await one.verify()
  deps.users.create = create
  expect(reply.status).toBe(500)
  await onDatabaseClock(text(one.started.body, 'id'))
  return one
}

describe('the abandon sweep against a real Postgres', () => {
  test('a committed account resolves its case in the same transaction', async () => {
    const { verify } = await start()

    const done = await verify()

    expect(done.status).toBe(200)
    const [only] = await cases()
    expect(only?.outcome).toBe('not_needed')
    expect(String(only?.core_organization_id)).toHaveLength(36)
  })

  test('an address lost to another sign-up is abandoned in the request and the case resolved', async () => {
    const { email, started, verify } = await start()
    const tenant = Bootstrap.requireTenant(deps)
    const before = deps.membership.abandons.length
    const attempt = await deps.flowAttempts.findById(tenant.environmentId, text(started.body, 'id'))
    // The address is taken by someone else between the check and the insert.
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

    const lost = await verify()

    expect(lost.status).toBe(409)
    // The in-request abandon resolved it (core answered), not the failed insert.
    const [only] = await cases()
    expect(only?.id).toBe(attempt?.id)
    expect(only?.outcome).toBe('done')
    expect(deps.membership.abandons).toHaveLength(before + 1)
    deps.membership.createOrganization = create
  })

  test('a crash after core answers is abandoned once the attempt and its grace are over', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    const before = deps.membership.abandons.length
    await crash()
    const [open] = await cases()
    expect(open?.outcome).toBeNull()

    expect((await Abandon.sweep(deps, tenant)).abandoned).toBe(0)
    await age(10 * 60 + 5)
    expect((await Abandon.sweep(deps, tenant)).abandoned).toBe(0)
    await age(Abandon.ABANDON_GRACE_MS / 1000)
    const result = await Abandon.sweep(deps, tenant)

    expect(result.abandoned).toBe(1)
    expect(deps.membership.abandons).toHaveLength(before + 1)
    expect((await cases())[0]?.outcome).toBe('done')
  })

  test('an account that exists is never abandoned, whatever the case says', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    const { email, started } = await crash()
    const attempt = await deps.flowAttempts.findById(tenant.environmentId, text(started.body, 'id'))
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
    const before = deps.membership.abandons.length
    await age(FAR)

    const result = await Abandon.sweep(deps, tenant)

    expect(result.account_exists).toBe(1)
    expect(deps.membership.abandons).toHaveLength(before)
  })

  test('a busy core leaves the case leased, and it is tried again when the lease ends', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    await crash()
    await age(FAR)
    deps.membership.failNextAbandons(3)

    const first = await Abandon.sweep(deps, tenant)
    const during = await Abandon.sweep(deps, tenant)
    await age(Abandon.leaseMs(deps.env.ABANDON_SWEEP_BATCH_SIZE) / 1000 + 1)
    const next = await Abandon.sweep(deps, tenant)

    expect(first.retry_later).toBe(1)
    expect(during.retry_later).toBe(0)
    expect(next.abandoned).toBe(1)
    expect((await cases())[0]?.attempts).toBe(2)
  })

  test('sweeps running at once take different cases: core is called once for each', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    for (let i = 0; i < 6; i += 1) {
      await crash()
    }
    await age(FAR)
    const before = deps.membership.abandons.length
    const small = { ...deps, env: { ...deps.env, ABANDON_SWEEP_BATCH_SIZE: 2 } }

    const results = await Promise.all([
      Abandon.sweep(small, tenant),
      Abandon.sweep(small, tenant),
      Abandon.sweep(small, tenant),
    ])

    expect(results.reduce((sum, result) => sum + result.abandoned, 0)).toBe(6)
    const keys = deps.membership.abandons.slice(before).map((entry) => entry.idempotencyKey)
    expect(keys).toHaveLength(6)
    expect(new Set(keys).size).toBe(6)
  })

  test('runs under the advisory lock: while one instance sweeps another skips', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    let inner: Abandon.RunOutcome | undefined

    const held = await deps.exclusive.runExclusive(Abandon.ABANDON_SWEEP_LOCK, async () => {
      inner = await Abandon.runOnce(deps, tenant)
    })

    expect(held).toBe(true)
    expect(inner).toBe('skipped')
    expect(await Abandon.runOnce(deps, tenant)).toBe('swept')
  })

  test('the case is invisible to another environment', async () => {
    await crash()
    const { rows } = await owner.query(`select id from auth.environments where id <> $1`, [
      Bootstrap.requireTenant(deps).environmentId,
    ])
    const other = String(rows[0]?.id)

    const seen = await withEnvironment(deps.db, other, (tx) =>
      tx.execute(sql`select count(*)::int as n from auth.abandon_cases`)
    )
    const claimed = await deps.abandonCases.claim(other, 10, 1_000)

    expect(Number(seen.rows[0]?.n)).toBe(0)
    expect(claimed).toEqual([])
  })

  test('a spent case is given up, and resolved cases are purged after a day', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    await crash()
    expect(await cases()).toHaveLength(1)
    await age(FAR)
    await inEnvironment(owner, tenant.environmentId, (query) =>
      query('update auth.abandon_cases set attempts = 100 where resolved_at is null')
    )

    const result = await Abandon.sweep(deps, tenant)
    expect(result.spent).toBe(1)
    expect((await cases())[0]?.outcome).toBe('gave_up')
    expect(await deps.abandonCases.purgeResolved(tenant.environmentId, 10)).toBe(0)
    await inEnvironment(owner, tenant.environmentId, (query) =>
      query(`update auth.abandon_cases set resolved_at = resolved_at - interval '2 days'`)
    )

    expect(await deps.abandonCases.purgeResolved(tenant.environmentId, 10)).toBe(1)
    expect(await cases()).toEqual([])
  })

  const newUser = (id: string, email: string, caseId: string) => {
    const tenant = Bootstrap.requireTenant(deps)
    return {
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email,
      emailNormalized: email,
      emailVerifiedAt: new Date(),
      firstName: null,
      lastName: null,
      createdAt: new Date(),
      identityId: crypto.randomUUID(),
      credentialId: crypto.randomUUID(),
      passwordHash: '$argon2id$x',
      settlesAbandonCase: caseId,
    }
  }
  const recordCase = async (userId: string) => {
    const tenant = Bootstrap.requireTenant(deps)
    const id = crypto.randomUUID()
    await deps.abandonCases.record({
      id,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: null,
      userId,
      attemptId: id,
      attemptExpiresAt: new Date(Date.now() + 600_000),
      graceMs: 30_000,
    })
    return id
  }

  test('an account whose case the sweep claimed first is rejected and writes no user row', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    const userId = crypto.randomUUID()
    const caseId = await recordCase(userId)
    await age(FAR)
    expect(await deps.abandonCases.claim(tenant.environmentId, 10, 60_000)).toHaveLength(1)

    await expect(deps.users.create(newUser(userId, 'late@northline.app', caseId))).rejects.toThrow(
      AbandonCaseClaimed
    )

    expect(await deps.users.findById(tenant.environmentId, userId)).toBeNull()
    expect(await deps.users.findByEmail(tenant.environmentId, 'late@northline.app')).toBeNull()
    expect((await cases())[0]?.outcome).toBeNull()
  })

  test('an account that settles first leaves nothing for a sweep to claim, and the Organization is kept', async () => {
    const tenant = Bootstrap.requireTenant(deps)
    const { verify } = await start()
    const before = deps.membership.abandons.length

    expect((await verify()).status).toBe(200)
    await age(FAR)
    const result = await Abandon.sweep(deps, tenant)

    expect((await cases())[0]?.outcome).toBe('not_needed')
    expect(result.abandoned + result.account_exists + result.no_organization).toBe(0)
    expect(deps.membership.abandons).toHaveLength(before)
  })

  test('a retry whose account exists meets the unique violation, not the settle', async () => {
    const userId = crypto.randomUUID()
    const caseId = await recordCase(userId)
    expect(await deps.users.create(newUser(userId, 'once@northline.app', caseId))).toBe(true)

    expect(await deps.users.create(newUser(userId, 'once@northline.app', caseId))).toBe(false)
  })
})
