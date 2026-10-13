import { describe, expect, test } from 'bun:test'
import { formatId, type UserId } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { AUTH_ERRORS } from '~/errors'
import { type ConcurrencyLimiter, Saturated } from '~/lib/concurrency'
import { createReadyDeps } from '~/testing'
import { at, call, emailedCode, text, wrongCode } from '~/testing/client'

const PASSWORD = 'correct horse battery'

async function setup() {
  const deps = await createReadyDeps()
  const app = createApp(deps)
  let n = 0
  const nextEmail = () => `maya${++n}@northline.app`
  const signUp = (
    email: string,
    extra: Record<string, unknown> = { organizationName: 'Northline' }
  ) =>
    call(app, 'POST', '/v1/client/sign-ups', {
      client: 'ios',
      body: { email, password: PASSWORD, ...extra },
    })
  const verify = (reply: { body: unknown }, code: string) =>
    call(app, 'POST', `/v1/client/sign-ups/${text(reply.body, 'id')}/verify-email`, {
      attempt: text(reply.body, 'attemptSecret'),
      body: { code },
    })
  const signedUp = async (email = nextEmail()) => {
    const started = await signUp(email)
    const done = await verify(started, emailedCode(deps, email))
    return { email, started, done }
  }
  return { deps, app, nextEmail, signUp, verify, signedUp }
}

describe('sign-up', () => {
  test('emails a code, creates no account until it is verified, then signs the user in', async () => {
    const { deps, app, nextEmail, signUp, verify } = await setup()
    const email = nextEmail()

    const started = await signUp(email)

    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({
      kind: 'sign_up',
      step: { status: 'needs_email_verification', strategies: ['email_code'] },
    })
    expect(at(started.body, 'session')).toBeUndefined()
    expect(text(started.body, 'attemptSecret')).toMatch(/^tula_at_[A-Za-z0-9_-]{43}$/)
    expect(await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)).toBeNull()
    expect(deps.membership.calls.create).toBe(0)

    const done = await verify(started, emailedCode(deps, email))

    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({
      step: { status: 'complete' },
      session: { organization: { role: 'owner' } },
    })
    expect(text(done.body, 'session.refreshToken')).toStartWith('tula_rt_')
    expect(JSON.stringify(done.body)).not.toContain(PASSWORD)
    expect(deps.membership.calls.create).toBe(1)
    expect(deps.membership.organizations[0]?.name).toBe('Northline')
    const me = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(done.body, 'session.accessToken'),
    })
    expect(me.body).toMatchObject({ email, organization: { role: 'owner' } })
    expect(at(me.body, 'emailVerifiedAt')).toBeString()
  })

  test('joins the inviting Organization when given an invitation token', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const organizationId = `org_${'a'.repeat(32)}`
    deps.membership.invite('inv-1', { email, organizationId, role: 'rep' })

    const started = await signUp(email, { invitationToken: 'inv-1' })
    const done = await verify(started, emailedCode(deps, email))

    expect(done.body).toMatchObject({
      session: { organization: { id: organizationId, role: 'rep' } },
    })
    expect(deps.membership.calls.accept).toBe(1)
    expect(deps.membership.calls.create).toBe(0)
  })

  test('does not keep the invitation token in the clear on the attempt', async () => {
    const { deps, signUp, nextEmail } = await setup()
    const started = await signUp(nextEmail(), { invitationToken: 'inv-secret-token' })

    const stored = await deps.flowAttempts.findById(
      deps.tenant.current?.environmentId ?? '',
      text(started.body, 'id')
    )

    expect(JSON.stringify(stored)).not.toContain('inv-secret-token')
  })

  test.each([
    ['neither', {}],
    ['both', { organizationName: 'Northline', invitationToken: 'inv-1' }],
  ])('needs exactly one of an Organization name and an invitation: %s', async (_name, extra) => {
    const { signUp, nextEmail } = await setup()

    const reply = await signUp(nextEmail(), extra)

    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ error: { code: 'request.invalid' } })
  })

  test('with the membership service down, no account is made and the code still works', async () => {
    const { deps, app, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    deps.membership.breakDown(true)

    const failed = await verify(started, code)

    expect(failed.status).toBe(503)
    expect(failed.body).toMatchObject({ error: { code: 'membership.unavailable' } })
    expect(deps.reported).toHaveLength(1)
    expect(await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)).toBeNull()
    const early = await call(app, 'POST', '/v1/client/sign-ins', { body: { identifier: email } })
    const attempt = { attempt: text(early.body, 'attemptSecret') }
    const noAccount = await call(
      app,
      'POST',
      `/v1/client/sign-ins/${text(early.body, 'id')}/password`,
      { ...attempt, body: { password: PASSWORD } }
    )
    expect(noAccount.status).toBe(401)

    deps.membership.breakDown(false)
    const retried = await verify(started, code)

    expect(retried.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('a retry after a lost response reuses the same Organization', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    // The first request created the Organization, then the commit never happened.
    const attempt = await deps.flowAttempts.findById(
      deps.tenant.current?.environmentId ?? '',
      text(started.body, 'id')
    )
    await deps.membership.createOrganization({
      userId: formatId('usr', String(attempt?.state.userId)) as UserId,
      name: 'Northline',
      idempotencyKey: `signup:${text(started.body, 'id')}`,
    })

    const done = await verify(started, code)

    expect(done.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('an invitation core refuses makes no account and is a 422', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email, { invitationToken: 'nobody-invited-this' })

    const reply = await verify(started, emailedCode(deps, email))

    expect(reply.status).toBe(422)
    expect(reply.body).toMatchObject({ error: { code: 'signup.invitation_invalid' } })
    expect(await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)).toBeNull()
  })

  test('checks the address before the password', async () => {
    const { app } = await setup()

    const reply = await call(app, 'POST', '/v1/client/sign-ups', {
      body: { email: 'not-an-email', password: 'x', organizationName: 'Northline' },
    })

    expect(reply.status).toBe(422)
    expect(reply.body).toMatchObject({ error: { code: 'email.invalid' } })
  })

  test('refuses weak, personal and breached passwords and says which rule', async () => {
    const { app, nextEmail } = await setup()
    const start = (password: string, email = nextEmail()) =>
      call(app, 'POST', '/v1/client/sign-ups', {
        body: { email, password, organizationName: 'Northline' },
      })

    const short = await start('x')
    expect(short.status).toBe(422)
    expect(short.body).toMatchObject({
      error: { code: 'password.too_short', details: { min: 10 } },
    })
    expect(at(short.body, 'error.details.errors.0.field')).toBe('password')

    const personal = await start('maya-northline-1', 'maya-northline@x.app')
    expect(personal.body).toMatchObject({ error: { code: 'password.contains_user_info' } })

    const common = await start('password123')
    expect(common.body).toMatchObject({ error: { code: 'password.common' } })
  })

  test('refuses a password that appears in a breach', async () => {
    const bad = 'a-long-but-breached-secret'
    const deps = await createReadyDeps({ breached: [bad] })

    const reply = await call(createApp(deps), 'POST', '/v1/client/sign-ups', {
      body: { email: 'maya@northline.app', password: bad, organizationName: 'Northline' },
    })

    expect(reply.status).toBe(422)
    expect(reply.body).toMatchObject({ error: { code: 'password.breached' } })
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('a wrong code says how many tries remain; five wrong codes end the code, even the right one', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const right = emailedCode(deps, email)

    const first = await verify(started, wrongCode(right))
    expect(first.status).toBe(422)
    expect(first.body).toMatchObject({
      error: { code: 'verification.invalid_code', details: { attemptsRemaining: 4 } },
    })
    for (let n = 0; n < 4; n++) {
      await verify(started, wrongCode(right))
    }

    const locked = await verify(started, right)

    expect(locked.status).toBe(429)
    expect(locked.body).toMatchObject({ error: { code: 'verification.too_many_attempts' } })
    expect(await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)).toBeNull()
  })

  test('a malformed code is a validation error, not a guess', async () => {
    const { signUp, verify, nextEmail } = await setup()
    const started = await signUp(nextEmail())

    const reply = await verify(started, '12345')

    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ error: { code: 'request.invalid' } })
  })

  test('an address that already has an account gets the same answer and a notice, never a code', async () => {
    const { deps, signUp, verify, signedUp } = await setup()
    const { email, started: first } = await signedUp()
    const realCode = emailedCode(deps, email)
    deps.clock.advance('2m')
    const before = deps.mailer.outbox.length

    const again = await signUp(email, { organizationName: 'Another' })

    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ step: { status: 'needs_email_verification' } })
    expect(Object.keys(again.body as object).sort()).toEqual(
      Object.keys(first.body as object).sort()
    )
    expect(deps.mailer.outbox).toHaveLength(before + 1)
    expect(deps.mailer.last().text).not.toMatch(/\b\d{6}\b/)
    const stolen = await verify(again, realCode)
    expect(stolen.status).toBe(422)
    expect(stolen.body).toMatchObject({ error: { code: 'verification.invalid_code' } })
    expect(deps.membership.calls.create).toBe(1)
  })

  test('limits emails to one address: a resend inside the cooldown is refused', async () => {
    const { deps, app, signUp, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)

    const resend = () =>
      call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/resend-code`, {
        attempt: text(started.body, 'attemptSecret'),
      })
    const tooSoon = await resend()
    expect(tooSoon.status).toBe(429)
    expect(at(tooSoon.body, 'error.details.retryAfter')).toBeNumber()

    deps.clock.advance('2m')
    const later = await resend()
    expect(later.status).toBe(200)
    expect(deps.mailer.outbox).toHaveLength(2)
  })

  test('a mail failure keeps no attempt and says so', async () => {
    const { deps, signUp, nextEmail } = await setup()
    deps.mailer.failing = true

    const reply = await signUp(nextEmail())

    expect(reply.status).toBe(503)
    expect(reply.body).toMatchObject({ error: { code: AUTH_ERRORS['mail.unavailable'].code } })
  })

  test('serves the length limits of the password policy', async () => {
    const { app } = await setup()

    const reply = await call(app, 'GET', '/v1/client/password-policy')

    expect(reply.body).toEqual({ minLength: 10, maxLength: 128 })
  })
})

describe('attempt secrets', () => {
  test('an attempt is gone without its own secret, with the same answer for every reason', async () => {
    const { deps, app, nextEmail, signUp } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    const id = text(started.body, 'id')
    const other = await call(app, 'POST', '/v1/client/sign-ins', { body: { identifier: email } })
    const verify = (path: string, attempt?: string) =>
      call(app, 'POST', path, { ...(attempt === undefined ? {} : { attempt }), body: { code } })

    const unknown = await verify(
      '/v1/client/sign-ups/00000000-0000-7000-8000-00000000dead/verify-email',
      'tula_at_none'
    )
    const notUuid = await verify('/v1/client/sign-ups/nope/verify-email', 'tula_at_none')
    const none = await verify(`/v1/client/sign-ups/${id}/verify-email`)
    const wrong = await verify(
      `/v1/client/sign-ups/${id}/verify-email`,
      `${text(started.body, 'attemptSecret')}x`
    )
    const foreign = await verify(
      `/v1/client/sign-ups/${id}/verify-email`,
      text(other.body, 'attemptSecret')
    )

    for (const reply of [unknown, notUuid, none, wrong, foreign]) {
      expect(reply.status).toBe(404)
      expect(reply.body).toEqual(unknown.body)
    }
    expect(at(unknown.body, 'error.code')).toBe('flow.not_found')
    const right = await verify(
      `/v1/client/sign-ups/${id}/verify-email`,
      text(started.body, 'attemptSecret')
    )
    expect(right.status).toBe(200)
    expect(at(right.body, 'attemptSecret')).toBeUndefined()
    const again = await verify(
      `/v1/client/sign-ups/${id}/verify-email`,
      text(started.body, 'attemptSecret')
    )
    expect(again.status).toBe(404)
  })
})

describe('sign-in', () => {
  async function startSignIn(app: Awaited<ReturnType<typeof setup>>['app'], identifier: string) {
    const started = await call(app, 'POST', '/v1/client/sign-ins', {
      client: 'ios',
      body: { identifier },
    })
    const password = (value: string) =>
      call(app, 'POST', `/v1/client/sign-ins/${text(started.body, 'id')}/password`, {
        attempt: text(started.body, 'attemptSecret'),
        body: { password: value },
      })
    return { started, password }
  }

  test('with the hash limiter full the password step of a sign-in is a 503 with Retry-After', async () => {
    const { deps, app, signedUp } = await setup()
    const { email } = await signedUp()
    const { password } = await startSignIn(app, email)
    deps.limits = {
      ...deps.limits,
      hash: {
        run: async () => {
          throw new Saturated()
        },
      },
    }

    const reply = await password(PASSWORD)

    expect(reply.status).toBe(503)
    expect(reply.body).toMatchObject({ error: { code: 'server.unavailable' } })
    expect(deps.reported).toHaveLength(0)
  })

  test('a known and an unknown address start identically and fail identically', async () => {
    const { app, signedUp, nextEmail } = await setup()
    const { email } = await signedUp()
    const known = await startSignIn(app, email)
    const stranger = await startSignIn(app, nextEmail())

    expect(known.started.body).toMatchObject({
      kind: 'sign_in',
      step: { status: 'needs_password' },
    })
    expect(Object.keys(known.started.body as object).sort()).toEqual(
      Object.keys(stranger.started.body as object).sort()
    )
    const wrong = await known.password(`${PASSWORD}-wrong`)
    const unknown = await stranger.password(PASSWORD)
    expect(wrong.status).toBe(401)
    expect(wrong.body).toEqual(unknown.body)
    expect(at(wrong.body, 'error.code')).toBe('auth.invalid_credentials')
  })

  test('the right password completes with a new session and tokens the kit verifies', async () => {
    const { app, signedUp } = await setup()
    const { email, done } = await signedUp()
    const { password } = await startSignIn(app, email)

    const reply = await password(PASSWORD)

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      step: { status: 'complete', userId: at(done.body, 'step.userId') },
      session: { organization: { role: 'owner' } },
    })
    expect(text(reply.body, 'session.sessionId')).not.toBe(text(done.body, 'session.sessionId'))
    const me = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(reply.body, 'session.accessToken'),
    })
    expect(me.status).toBe(200)
  })

  test('is locked out after repeated wrong passwords, even for the right one', async () => {
    const { app, signedUp } = await setup()
    const { email } = await signedUp()
    const { password } = await startSignIn(app, email)

    for (let n = 0; n < 6; n++) {
      expect((await password(`${PASSWORD}-wrong`)).status).toBe(401)
    }
    const locked = await password(PASSWORD)

    expect(locked.status).toBe(429)
    expect(locked.body).toMatchObject({ error: { code: 'rate.limited' } })
    expect(at(locked.body, 'error.details.retryAfter')).toBeNumber()
  })

  test('an account with no Organization gets no session and no token, and is reported', async () => {
    const { deps, app, signedUp } = await setup()
    const { email, done } = await signedUp()
    deps.membership.forget(text(done.body, 'step.userId') as UserId)
    const { password } = await startSignIn(app, email)

    const reply = await password(PASSWORD)

    expect(reply.status).toBe(403)
    expect(reply.body).toMatchObject({ error: { code: 'auth.no_organization' } })
    expect(JSON.stringify(reply.body)).not.toContain('accessToken')
    expect(deps.reported).toHaveLength(1)
    expect(deps.reported[0]?.context.status).toBe(403)
    const user = await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)
    const sessions = await deps.sessions.listActive(
      deps.tenant.current?.environmentId ?? '',
      user?.id ?? '',
      deps.clock.now(),
      10
    )
    expect(sessions).toHaveLength(1)
  })
})

describe('text the database cannot store', () => {
  test.each([
    ['sign-in identifier', '/v1/client/sign-ins', { identifier: 'maya\u0000@northline.app' }],
    [
      'sign-up email',
      '/v1/client/sign-ups',
      { email: 'maya\u0000@northline.app', password: PASSWORD, organizationName: 'Northline' },
    ],
    [
      'first name',
      '/v1/client/sign-ups',
      {
        email: 'a@northline.app',
        password: PASSWORD,
        firstName: 'Ma\u0000ya',
        organizationName: 'Northline',
      },
    ],
    [
      'last name',
      '/v1/client/sign-ups',
      {
        email: 'a@northline.app',
        password: PASSWORD,
        lastName: 'Pa\u0000tel',
        organizationName: 'Northline',
      },
    ],
    [
      'organization name',
      '/v1/client/sign-ups',
      { email: 'a@northline.app', password: PASSWORD, organizationName: 'North\u0000line' },
    ],
    [
      'invitation token',
      '/v1/client/sign-ups',
      { email: 'a@northline.app', password: PASSWORD, invitationToken: 'inv\u0000-1' },
    ],
  ])('a NUL in the %s is a 400, not an unexpected error', async (_field, path, body) => {
    const { deps, app } = await setup()

    const reply = await call(app, 'POST', path, { body })

    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ error: { code: 'request.invalid' } })
    expect(deps.reported).toHaveLength(0)
  })
})

describe('what a sign-up costs before it is allowed', () => {
  /** Counts how often the limiter is used and the most that ever ran inside it at once. */
  function watching(limiter: ConcurrencyLimiter) {
    const seen = { runs: 0, peak: 0, running: 0 }
    const watched: ConcurrencyLimiter = {
      async run(work) {
        seen.runs += 1
        return limiter.run(async () => {
          seen.running += 1
          seen.peak = Math.max(seen.peak, seen.running)
          try {
            return await work()
          } finally {
            seen.running -= 1
          }
        })
      },
    }
    return { watched, seen }
  }

  test('a sign-up over the hourly cap makes no breach lookup and no hash', async () => {
    const { deps, signUp } = await setup()
    const hashing = watching(deps.limits.hash)
    deps.limits = { ...deps.limits, hash: hashing.watched }
    for (let n = 0; n < 5; n++) {
      expect((await signUp('cap@northline.app')).status).toBe(200)
      deps.clock.advance('2m')
    }
    const checksBefore = deps.breachChecker.checks
    const hashesBefore = hashing.seen.runs

    const over = await signUp('cap@northline.app')

    expect(over.status).toBe(429)
    expect(over.body).toMatchObject({ error: { code: 'verification.too_many_attempts' } })
    expect(deps.breachChecker.checks).toBe(checksBefore)
    expect(hashing.seen.runs).toBe(hashesBefore)
  })

  test('a password the policy refuses makes no breach lookup, no hash and spends no send', async () => {
    const { deps, signUp } = await setup()
    const hashing = watching(deps.limits.hash)
    deps.limits = { ...deps.limits, hash: hashing.watched }

    const refused = await call(createApp(deps), 'POST', '/v1/client/sign-ups', {
      body: { email: 'weak@northline.app', password: 'short', organizationName: 'Northline' },
    })
    const checksAfterRefusal = deps.breachChecker.checks
    const hashesAfterRefusal = hashing.seen.runs
    const retried = await signUp('weak@northline.app')

    expect(refused.status).toBe(422)
    expect(checksAfterRefusal).toBe(0)
    expect(hashesAfterRefusal).toBe(0)
    expect(retried.status).toBe(200)
  })

  test('fifty sign-ups at once never run more than the configured number of hashes together', async () => {
    const deps = await createReadyDeps({
      env: { HASH_CONCURRENCY: '3', HASH_QUEUE: '100', BREACH_CHECK_QUEUE: '100' },
    })
    const hashing = watching(deps.limits.hash)
    deps.limits = { ...deps.limits, hash: hashing.watched }
    const app = createApp(deps)

    const replies = await Promise.all(
      Array.from({ length: 50 }, (_, n) =>
        call(app, 'POST', '/v1/client/sign-ups', {
          body: {
            email: `burst${n}@northline.app`,
            password: PASSWORD,
            organizationName: 'Northline',
          },
        })
      )
    )

    expect(replies.map((reply) => reply.status)).toEqual(Array(50).fill(200))
    expect(hashing.seen.runs).toBe(50)
    expect(hashing.seen.peak).toBeLessThanOrEqual(3)
    expect(hashing.seen.peak).toBeGreaterThan(0)
  })

  test.each(['hash', 'breach'] as const)(
    'with the %s limiter full a sign-up is a 503 with Retry-After and is not reported',
    async (which) => {
      const { deps, app } = await setup()
      deps.limits = {
        ...deps.limits,
        [which]: {
          run: async () => {
            throw new Saturated()
          },
        },
      }

      const response = await app.request('/v1/client/sign-ups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'busy@northline.app',
          password: PASSWORD,
          organizationName: 'Northline',
        }),
      })

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: { code: 'server.unavailable' } })
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect(deps.reported).toHaveLength(0)
    }
  )
})
