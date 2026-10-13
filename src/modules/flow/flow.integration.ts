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
    const madeBefore = deps.membership.organizations.length
    const abandonedBefore = deps.membership.abandons.length
    // Both started before either had an account, so both are real attempts.
    const results = await Promise.all([
      first.verify(emailedCodeFor(first.started)),
      second.verify(emailedCode(deps, email)),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await countUsers(email)).toBe(1)
    // Whichever way the loser lost (before core was asked, or at the insert), no Organization is
    // left without an owner: every one made beyond the winner's was abandoned.
    expect(deps.membership.abandons.length - abandonedBefore).toBe(
      deps.membership.organizations.length - madeBefore - 1
    )
    expect(deps.reported.filter((r) => String(r.error).includes('reconcile'))).toHaveLength(0)
  })
})

describe('text Postgres refuses, over a real Postgres', () => {
  test('an unpaired surrogate in a name is a 400 that reports nothing and keeps no attempt', async () => {
    const app = createApp(deps)
    const reportedBefore = deps.reported.length
    const [before] = await rows(sql`select count(*)::int as n from auth.flow_attempts`)

    const reply = await call(app, 'POST', '/v1/client/sign-ups', {
      body: {
        email: 'lone@northline.app',
        password: PASSWORD,
        firstName: '\ud800',
        organizationName: 'Northline',
      },
    })

    expect(reply.status).toBe(400)
    expect(deps.reported).toHaveLength(reportedBefore)
    const [after] = await rows(sql`select count(*)::int as n from auth.flow_attempts`)
    expect(after?.n).toBe(before?.n)
  })

  test('a paired surrogate (an emoji) in the names is stored and signs up', async () => {
    const app = createApp(deps)
    const started = await call(app, 'POST', '/v1/client/sign-ups', {
      body: {
        email: 'emoji@northline.app',
        password: PASSWORD,
        firstName: 'Maya \u{1F600}',
        organizationName: 'North\u{1F600}line',
      },
    })

    const done = await call(
      app,
      'POST',
      `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
      {
        attempt: text(started.body, 'attemptSecret'),
        body: { code: emailedCode(deps, 'emoji@northline.app') },
      }
    )

    expect(started.status).toBe(200)
    expect(done.status).toBe(200)
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

describe('a slow core service, over a real Postgres', () => {
  test('twelve sign-ups waiting on core leave sign-in, refresh and readiness answering', async () => {
    const known = await signUp('known@northline.app')
    const done = await known.verify(known.code())
    const refreshToken = text(done.body, 'session.refreshToken')
    deps.readinessChecks = [
      {
        name: 'database',
        run: async () => {
          await deps.db.execute(sql`select 1`)
        },
      },
    ]
    // More sign-ups than the pool has connections, each waiting on a core that does not answer.
    const waiting = await Promise.all(
      Array.from({ length: deps.env.DB_POOL_MAX + 2 }, async (_, n) => {
        const pending = await signUp(`slow${n}@northline.app`)
        return { verify: pending.verify, code: pending.code() }
      })
    )
    const release = deps.membership.hold()
    const callsBefore = deps.membership.calls.create
    let finished = 0
    const verifications = waiting.map(async ({ verify, code }) => {
      const reply = await verify(code)
      finished += 1
      return reply
    })
    for (let tries = 0; deps.membership.calls.create - callsBefore < waiting.length; tries++) {
      if (tries > 1_000) {
        throw new Error('the sign-ups never reached core')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const app = createApp(deps)
    const attempt = await call(app, 'POST', '/v1/client/sign-ins', {
      body: { identifier: 'known@northline.app' },
    })
    const signedIn = await call(
      app,
      'POST',
      `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`,
      { attempt: text(attempt.body, 'attemptSecret'), body: { password: PASSWORD } }
    )
    const refreshed = await call(app, 'POST', '/v1/client/sessions/refresh', {
      body: { refreshToken },
    })
    const ready = await app.request('/readyz')
    const stillWaiting = finished

    release()
    const replies = await Promise.all(verifications)

    expect(signedIn.status).toBe(200)
    expect(refreshed.status).toBe(200)
    expect(ready.status).toBe(200)
    // Every answer above came while all the sign-ups were still waiting on core.
    expect(stillWaiting).toBe(0)
    expect(replies.map((reply) => reply.status)).toEqual(Array(waiting.length).fill(200))
  })
})
