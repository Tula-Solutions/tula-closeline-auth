import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { withEnvironment } from 'tula-closeline-db'
import { createApp } from '~/app'
import { call, emailedCode, text } from '~/testing/client'
import { createPostgresDeps } from '~/testing/postgres-deps'

const PASSWORD = 'correct horse battery'

let deps: Awaited<ReturnType<typeof createPostgresDeps>>

beforeAll(async () => {
  deps = await createPostgresDeps()
})
afterAll(async () => {
  await deps.stop()
})

async function signUp(email: string) {
  const app = createApp(deps)
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'ios',
    body: { email, password: PASSWORD, organizationName: 'Northline' },
  })
  const verify = (code: string) =>
    call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      attempt: text(started.body, 'attemptSecret'),
      body: { code },
    })
  return { app, started, verify, code: () => emailedCode(deps, email) }
}

/** Runs SQL as the service does, scoped to the environment (the owner is blocked by RLS too). */
async function rows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const environmentId = deps.tenant.current?.environmentId ?? ''
  const result = await withEnvironment(deps.db, environmentId, (tx) => tx.execute(query))
  return result.rows as Record<string, unknown>[]
}

async function countUsers(email: string): Promise<number> {
  const [row] = await rows(
    sql`select count(*)::int as n from auth.users where email_normalized = ${email}`
  )
  return Number(row?.n)
}

describe('sign-up against a real Postgres', () => {
  test('creates the account, identity, credential and session; the password is only a hash', async () => {
    const email = 'one@northline.app'
    const { app, verify, code } = await signUp(email)

    const done = await verify(code())

    expect(done.status).toBe(200)
    const [row] = await rows(sql`
      select u.email_verified_at is not null as verified,
             (select count(*)::int from auth.identities i
               where i.user_id = u.id and i.provider = 'email') as identities,
             (select c.secret from auth.credentials c
               where c.user_id = u.id and c.type = 'password') as secret
        from auth.users u where u.email_normalized = ${email}`)
    expect(row?.verified).toBe(true)
    expect(row?.identities).toBe(1)
    expect(String(row?.secret)).toStartWith('$argon2id$')
    expect(String(row?.secret)).not.toContain(PASSWORD)
    const me = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(done.body, 'session.accessToken'),
    })
    expect(me.status).toBe(200)
  })

  test('when the membership step fails the transaction rolls back: no user, identity or credential', async () => {
    const email = 'two@northline.app'
    const { verify, code } = await signUp(email)
    deps.membership.breakDown(true)

    const failed = await verify(code())
    deps.membership.breakDown(false)

    expect(failed.status).toBe(503)
    expect(await countUsers(email)).toBe(0)
    const [rest] = await rows(
      sql`select count(*)::int as n from auth.identities where provider_subject = ${email}`
    )
    expect(rest?.n).toBe(0)
    const retried = await verify(code())
    expect(retried.status).toBe(200)
    expect(await countUsers(email)).toBe(1)
  })

  test('two verifications of one code at once make one account and one Organization', async () => {
    const email = 'three@northline.app'
    const { verify, code } = await signUp(email)
    const right = code()
    const before = deps.membership.organizations.length

    const replies = await Promise.all(Array.from({ length: 5 }, () => verify(right)))

    expect(replies.filter((r) => r.status === 200)).toHaveLength(1)
    expect(await countUsers(email)).toBe(1)
    expect(deps.membership.organizations.length - before).toBe(1)
  })

  test('two sign-ups for one address that both verify cannot both succeed', async () => {
    const email = 'four@northline.app'
    const first = await signUp(email)
    deps.clock.advance('2m')
    const second = await signUp(email)
    // Both started before either had an account, so both are real attempts.
    const results = await Promise.all([
      first.verify(emailedCodeFor(first.started)),
      second.verify(emailedCode(deps, email)),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await countUsers(email)).toBe(1)
  })
})

function emailedCodeFor(_started: unknown): string {
  // The first attempt's code is the first email sent to the address.
  const message = deps.mailer.outbox.find((m) => m.to === 'four@northline.app')
  const code = message ? /\b(\d{6})\b/.exec(message.text)?.[1] : undefined
  if (!code) {
    throw new Error('no code')
  }
  return code
}
