import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { withEnvironment } from 'tula-closeline-db'
import type { FakeAccount } from '~/adapters/memory/oidc-provider'
import { createApp } from '~/app'
import { call, emailedCode, text } from '~/testing/client'
import { createPostgresDeps } from '~/testing/postgres-deps'

const ORIGIN = 'https://app.example.com'
const PASSWORD = 'correct horse battery'
const MAYA: FakeAccount = { sub: 'google-sub-maya', email: 'maya@northline.app', name: 'Maya Lin' }

let deps: Awaited<ReturnType<typeof createPostgresDeps>>

beforeAll(async () => {
  deps = await createPostgresDeps()
  // The origin allow-list is read from the env of the deps.
  deps.env = { ...deps.env, SESSION_ALLOWED_ORIGINS: ORIGIN }
})
afterAll(async () => {
  await deps.stop()
})

const environmentId = () => deps.tenant.current?.environmentId ?? ''

async function rows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await withEnvironment(deps.db, environmentId(), (tx) => tx.execute(query))
  return result.rows as Record<string, unknown>[]
}

async function begin(app: ReturnType<typeof createApp>, intent: 'sign_in' | 'sign_up' = 'sign_up') {
  const reply = await call(app, 'POST', '/v1/client/google/start', {
    headers: { origin: ORIGIN },
    body: { intent },
  })
  const cookie = reply.headers.getSetCookie()[0]?.split(';')[0] ?? ''
  return { reply, cookie, url: text(reply.body, 'authorizationUrl') }
}

async function back(
  app: ReturnType<typeof createApp>,
  started: Awaited<ReturnType<typeof begin>>,
  account: FakeAccount
) {
  const query = await deps.oidc.visit(started.url, { account })
  return call(app, 'GET', `/v1/client/google/callback?${query}`, {
    headers: { cookie: started.cookie },
  })
}

const attemptOf = (reply: { headers: Headers }) =>
  new URL(reply.headers.get('location') ?? '', ORIGIN).searchParams.get('attempt') ?? ''

describe('Sign in with Google against a real Postgres', () => {
  test('a new person: nothing is created by the callback; complete writes user, identities and no credential in one go', async () => {
    const app = createApp(deps)
    const started = await begin(app)
    const redirect = await back(app, started, MAYA)
    const attemptId = attemptOf(redirect)

    expect(redirect.headers.get('location')).toBe(`/sign-up/google?attempt=${attemptId}`)
    expect(await rows(sql`select id from auth.users`)).toEqual([])
    const [stored] = await rows(
      sql`select status, identifier, state::text as state from auth.flow_attempts where id = ${attemptId}`
    )
    expect(stored).toMatchObject({ status: 'oidc_pending', identifier: 'maya@northline.app' })
    expect(String(stored?.state)).not.toContain('google-sub-maya')

    const done = await call(app, 'POST', '/v1/client/google/complete', {
      headers: { origin: ORIGIN, cookie: started.cookie },
      body: { attemptId, organizationName: 'Northline' },
    })

    expect(done.status).toBe(200)
    const [row] = await rows(sql`
      select u.email_verified_at is not null as verified,
             (select count(*)::int from auth.identities i where i.user_id = u.id and i.provider = 'google'
                and i.provider_subject = 'google-sub-maya') as google,
             (select count(*)::int from auth.identities i where i.user_id = u.id and i.provider = 'email') as email,
             (select count(*)::int from auth.credentials c where c.user_id = u.id) as credentials
      from auth.users u where u.email_normalized = 'maya@northline.app'`)
    expect(row).toEqual({ verified: true, google: 1, email: 1, credentials: 0 })
    const [attempt] = await rows(
      sql`select status, state::text as state from auth.flow_attempts where id = ${attemptId}`
    )
    expect(attempt?.status).toBe('complete')
    expect(String(attempt?.state)).not.toContain('google-sub-maya')

    const again = await call(app, 'POST', '/v1/client/google/complete', {
      headers: { origin: ORIGIN, cookie: started.cookie },
      body: { attemptId, organizationName: 'Northline' },
    })
    expect(again.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('a returning user signs in by sub and gets the refresh cookie', async () => {
    const app = createApp(deps)

    const reply = await back(app, await begin(app, 'sign_in'), MAYA)

    expect(reply.headers.get('location')).toBe('/')
    expect(reply.headers.getSetCookie().join('\n')).toContain('tula_refresh=tula_rt_')
  })

  test('a password account with the same address is linked and the link is recorded', async () => {
    const app = createApp(deps)
    const email = 'linked@northline.app'
    const started = await call(app, 'POST', '/v1/client/sign-ups', {
      client: 'browser',
      body: { email, password: PASSWORD, organizationName: 'Linked' },
    })
    await call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      client: 'browser',
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    })

    const reply = await back(app, await begin(app, 'sign_in'), {
      sub: 'google-sub-linked',
      email,
    })

    expect(reply.headers.get('location')).toBe('/')
    const [link] = await rows(sql`
      select (select count(*)::int from auth.identities where provider = 'google'
                and provider_subject = 'google-sub-linked') as identities,
             (select count(*)::int from auth.audit_logs where action = 'google_linked') as audits,
             (select count(*)::int from auth.credentials c join auth.users u on u.id = c.user_id
                where u.email_normalized = ${email}) as credentials`)
    expect(link).toEqual({ identities: 1, audits: 1, credentials: 1 })
  })

  test('two simultaneous completes make one user and consume the attempt once', async () => {
    const app = createApp(deps)
    const started = await begin(app)
    const attemptId = attemptOf(await back(app, started, { sub: 'sub-race', email: 'race@x.app' }))
    const run = () =>
      call(app, 'POST', '/v1/client/google/complete', {
        headers: { origin: ORIGIN, cookie: started.cookie },
        body: { attemptId, organizationName: 'Race' },
      })

    const replies = await Promise.all([run(), run()])

    expect(replies.map((r) => r.status).sort()).toEqual([200, 400])
    const [count] = await rows(
      sql`select count(*)::int as n from auth.users where email_normalized = 'race@x.app'`
    )
    expect(count?.n).toBe(1)
  })

  test('a crash after core succeeded and before the write leaves the attempt usable and the retry finishes', async () => {
    const app = createApp(deps)
    const started = await begin(app)
    const attemptId = attemptOf(
      await back(app, started, { sub: 'sub-crash', email: 'crash@x.app' })
    )
    const body = { attemptId, organizationName: 'Crash' }
    const before = deps.membership.organizations.length
    const write = spyOn(deps.users, 'createGoogleUser').mockRejectedValueOnce(new Error('died'))

    const crashed = await call(app, 'POST', '/v1/client/google/complete', {
      headers: { origin: ORIGIN, cookie: started.cookie },
      body,
    })
    write.mockRestore()

    expect(crashed.status).toBe(500)
    const [attempt] = await rows(sql`select status from auth.flow_attempts where id = ${attemptId}`)
    expect(attempt?.status).toBe('oidc_pending')
    const retry = await call(app, 'POST', '/v1/client/google/complete', {
      headers: { origin: ORIGIN, cookie: started.cookie },
      body,
    })
    expect(retry.status).toBe(200)
    expect(deps.membership.organizations.length).toBe(before + 1)
  })

  test('another environment cannot read or use the attempt', async () => {
    const app = createApp(deps)
    const started = await begin(app)
    const attemptId = attemptOf(await back(app, started, { sub: 'sub-iso', email: 'iso@x.app' }))
    const other = '00000000-0000-7000-8000-00000000ffff'

    const seen = await withEnvironment(deps.db, other, (tx) =>
      tx.execute(sql`select id from auth.flow_attempts where id = ${attemptId}`)
    )
    expect(seen.rows).toEqual([])
    expect(await deps.flowAttempts.findById(other, attemptId)).toBeNull()
  })
})
