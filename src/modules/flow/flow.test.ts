import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { decodeJwt } from 'jose'
import { AUTH_ERRORS, formatId, type UserId } from 'tula-closeline-contract'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { createApp } from '~/app'
import { type ConcurrencyLimiter, Saturated } from '~/lib/concurrency'
import * as Bootstrap from '~/modules/bootstrap/service'
import { ORPHAN_REPORT_WINDOW_MS, reportOrphan } from '~/modules/flow/service'
import * as Retention from '~/modules/retention/service'
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
    // An outage is logged, not reported per request (it would be one report for each client).
    expect(deps.reported).toHaveLength(0)
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

  test('a refund that fails during an outage is logged as what it is, and the 503 still goes out', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    deps.membership.breakDown(true)
    deps.verificationTokens.refundAttempt = async () => {
      throw new Error('connection reset')
    }

    const failed = await verify(started, code)

    expect(failed.status).toBe(503)
    expect(failed.body).toMatchObject({ error: { code: 'membership.unavailable' } })
    const logged = deps.logLines.filter((line) => line.includes('giving back the verification try'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('giving back the verification try failed')
    expect(deps.logLines.join('\n')).not.toContain('committed')
    expect(deps.logLines.join('\n')).not.toContain(email)
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
      email: 'maya@northline.app',
      memberName: null,
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

  test('limits emails to one address to five an hour, counting resends and sign-ups together', async () => {
    const { deps, app, signUp, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const resend = () =>
      call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/resend-code`, {
        attempt: text(started.body, 'attemptSecret'),
      })
    for (let n = 0; n < 4; n++) {
      deps.clock.advance('61s')
      expect((await resend()).status).toBe(200)
    }
    deps.clock.advance('61s')

    const sixth = await resend()

    expect(sixth.status).toBe(429)
    expect(at(sixth.body, 'error.details.retryAfter')).toBeGreaterThan(60)
    expect(deps.mailer.outbox).toHaveLength(5)
    deps.clock.advance('1h')
    expect((await signUp(email)).status).toBe(200)
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

  test('with the sign-in limiter full the password step of a sign-in is a 503 with Retry-After', async () => {
    const { deps, app, signedUp } = await setup()
    const { email } = await signedUp()
    const { password } = await startSignIn(app, email)
    deps.limits = {
      ...deps.limits,
      signIn: {
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

  test('a successful sign-in clears the failures, so a user who mistyped a few times is never locked out', async () => {
    const { app, signedUp } = await setup()
    const { email } = await signedUp()

    // Three wrong tries then the right one, four times over: twelve failures if none were
    // forgotten, which would lock the account long before the end.
    for (let round = 0; round < 4; round++) {
      const { password } = await startSignIn(app, email)
      for (let n = 0; n < 3; n++) {
        expect((await password(`${PASSWORD}-wrong`)).status).toBe(401)
      }
      expect((await password(PASSWORD)).status).toBe(200)
    }
  })

  test('a device with no known-device cookie is locked out by a stranger guessing wrong on the address (ADR 0014)', async () => {
    // Lockout stays keyed by address and counted up front for devices the account has not signed
    // in from; a device that has is exempt (known-device.suite.ts). This pins the first half.
    const { app, signedUp } = await setup()
    const { email } = await signedUp()
    for (let n = 0; n < 7; n++) {
      const { password } = await startSignIn(app, email)
      await password('a stranger guessing')
    }

    const { password } = await startSignIn(app, email)
    const victim = await password(PASSWORD)

    expect(victim.status).toBe(429)
    expect(victim.body).toMatchObject({ error: { code: 'rate.limited' } })
  })

  test('a password longer than any account can have is a wrong password and is never counted', async () => {
    const { app, signedUp } = await setup()
    const { email } = await signedUp()
    const { password } = await startSignIn(app, email)

    const refused = []
    for (let n = 0; n < 8; n++) {
      refused.push(await password('x'.repeat(2_000)))
    }
    const right = await password(PASSWORD)

    expect(refused.map((reply) => reply.status)).toEqual(Array(8).fill(401))
    expect(refused[0]?.body).toMatchObject({ error: { code: 'auth.invalid_credentials' } })
    expect(right.status).toBe(200)
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

  test.each([
    ['sign-in identifier', '/v1/client/sign-ins', { identifier: 'maya\ud800@northline.app' }],
    [
      'sign-up email',
      '/v1/client/sign-ups',
      { email: 'maya\udc00@northline.app', password: PASSWORD, organizationName: 'Northline' },
    ],
    [
      'first name',
      '/v1/client/sign-ups',
      {
        email: 'a@northline.app',
        password: PASSWORD,
        firstName: '\ud800',
        organizationName: 'Northline',
      },
    ],
    [
      'last name',
      '/v1/client/sign-ups',
      {
        email: 'a@northline.app',
        password: PASSWORD,
        lastName: 'Pa\ud83dtel',
        organizationName: 'Northline',
      },
    ],
    [
      'organization name',
      '/v1/client/sign-ups',
      { email: 'a@northline.app', password: PASSWORD, organizationName: 'North\udfffline' },
    ],
    [
      'invitation token',
      '/v1/client/sign-ups',
      { email: 'a@northline.app', password: PASSWORD, invitationToken: 'inv\ud800-1' },
    ],
  ])(
    'an unpaired surrogate in the %s is a 400 and nothing is reported or kept',
    async (_field, path, body) => {
      const { deps, app } = await setup()

      const reply = await call(app, 'POST', path, { body })

      expect(reply.status).toBe(400)
      expect(reply.body).toMatchObject({ error: { code: 'request.invalid' } })
      expect(deps.reported).toHaveLength(0)
      expect(deps.mailer.outbox).toHaveLength(0)
    }
  )

  test('a paired surrogate (an emoji) is ordinary text and is accepted', async () => {
    const { app } = await setup()

    const reply = await call(app, 'POST', '/v1/client/sign-ups', {
      body: {
        email: 'emoji@northline.app',
        password: PASSWORD,
        firstName: 'Maya \u{1F600}',
        organizationName: 'North\u{1F600}line',
      },
    })

    expect(reply.status).toBe(200)
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

  const hashes = spyOn(Bun.password, 'hash')
  afterEach(() => hashes.mockClear())

  test('a sign-up over the hourly cap makes no breach lookup and no hash', async () => {
    const { deps, signUp } = await setup()
    for (let n = 0; n < 5; n++) {
      expect((await signUp('cap@northline.app')).status).toBe(200)
      deps.clock.advance('2m')
    }
    const checksBefore = deps.breachChecker.checks
    const hashesBefore = hashes.mock.calls.length

    const over = await signUp('cap@northline.app')

    expect(over.status).toBe(429)
    expect(over.body).toMatchObject({ error: { code: 'verification.too_many_attempts' } })
    expect(deps.breachChecker.checks).toBe(checksBefore)
    expect(hashes.mock.calls.length).toBe(hashesBefore)
  })

  test('a password the policy refuses makes no breach lookup, no hash and spends no send', async () => {
    const { deps, signUp } = await setup()

    const refused = await call(createApp(deps), 'POST', '/v1/client/sign-ups', {
      body: { email: 'weak@northline.app', password: 'short', organizationName: 'Northline' },
    })
    const checksAfterRefusal = deps.breachChecker.checks
    const hashesAfterRefusal = hashes.mock.calls.length
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

describe('failures around the commit of a sign-up', () => {
  test.each([
    ['spending the code', 'verificationTokens', 'consume'],
    ['closing the attempt', 'flowAttempts', 'transition'],
  ] as const)(
    'a failure %s after the account exists is not an error: the user is signed up',
    async (_what, store, method) => {
      const { deps, signUp, verify, nextEmail } = await setup()
      const email = nextEmail()
      const started = await signUp(email)
      const code = emailedCode(deps, email)
      const target = deps[store] as unknown as Record<string, unknown>
      target[method] = async () => {
        throw new Error('connection reset')
      }

      const done = await verify(started, code)

      expect(done.status).toBe(200)
      expect(done.body).toMatchObject({ step: { status: 'complete' } })
      expect(
        await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)
      ).not.toBeNull()
      expect(deps.logLines.some((line) => line.includes('after the account was committed'))).toBe(
        true
      )
      expect(deps.logLines.join('\n')).not.toContain(email)
    }
  )

  test('session creation failing after the commit leaves an account that can sign in', async () => {
    const { deps, app, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    const create = deps.sessions.create.bind(deps.sessions)
    let failures = 1
    deps.sessions.create = async (...args) => {
      if (failures-- > 0) {
        throw new Error('connection reset')
      }
      return create(...args)
    }

    const failed = await verify(started, code)

    expect(failed.status).toBe(500)
    expect(
      await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)
    ).not.toBeNull()
    const attempt = await call(app, 'POST', '/v1/client/sign-ins', { body: { identifier: email } })
    const signedIn = await call(
      app,
      'POST',
      `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`,
      { attempt: text(attempt.body, 'attemptSecret'), body: { password: PASSWORD } }
    )
    expect(signedIn.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('an address taken before core is asked never reaches core', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const first = await signUp(email)
    const firstCode = emailedCode(deps, email)
    deps.clock.advance('2m')
    const second = await signUp(email)
    expect((await verify(first, firstCode)).status).toBe(200)
    const callsBefore = deps.membership.calls.create

    const lost = await verify(second, emailedCode(deps, email))

    expect(lost.status).toBe(409)
    expect(lost.body).toMatchObject({ error: { code: 'flow.invalid_step' } })
    expect(deps.membership.calls.create).toBe(callsBefore)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('losing the address to another sign-up while core is being asked is a 409 and the Organization is abandoned', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    const tenant = deps.tenant.current
    const createOrganization = deps.membership.createOrganization.bind(deps.membership)
    deps.membership.createOrganization = async (input) => {
      const created = await createOrganization(input)
      // Another sign-up for the same address commits while core is answering this one.
      await deps.users.create({
        id: crypto.randomUUID(),
        projectId: tenant?.projectId ?? '',
        environmentId: tenant?.environmentId ?? '',
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

    const lost = await verify(started, code)

    expect(lost.status).toBe(409)
    expect(lost.body).toMatchObject({ error: { code: 'flow.invalid_step' } })
    const org = deps.membership.organizations[0]
    if (!org) {
      throw new Error('no Organization was made')
    }
    expect(deps.membership.abandons).toEqual([
      {
        organizationId: org.organizationId,
        userId: org.owner,
        idempotencyKey: `abandon:${text(started.body, 'id')}`,
      },
    ])
    expect(deps.reported).toHaveLength(0)
    const lines = deps.logLines.join('\n')
    expect(lines).toContain(org?.organizationId ?? 'missing')
    expect(lines).not.toContain(email)
  })
})

describe('an Organization that core made and nobody owns', () => {
  type Setup = Awaited<ReturnType<typeof setup>>
  /** Makes the account write fail, as a database that errors for a reason other than a taken address. */
  function breakInsert(deps: Setup['deps']) {
    deps.users.create = async () => {
      throw new Error('connection reset')
    }
  }
  /** Another sign-up for the same address commits while core is answering this one. */
  function loseAddress(deps: Setup['deps'], email: string) {
    const tenant = deps.tenant.current
    const createOrganization = deps.membership.createOrganization.bind(deps.membership)
    deps.membership.createOrganization = async (input) => {
      const created = await createOrganization(input)
      await deps.users.create({
        id: crypto.randomUUID(),
        projectId: tenant?.projectId ?? '',
        environmentId: tenant?.environmentId ?? '',
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
  const reconcileReports = (deps: Setup['deps']) =>
    deps.reported.filter(
      (entry) => entry.error instanceof Error && entry.error.message.includes('reconcile')
    )
  const warnings = (deps: Setup['deps']) =>
    deps.logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === 40)
      .map((entry) => String(entry.msg))

  test('an insert that throws is reported by ids and never abandoned in the request', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    breakInsert(deps)

    const failed = await verify(started, code)

    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ error: { code: 'server.internal' } })
    expect(deps.membership.calls.abandon).toBe(0)
    const [report] = reconcileReports(deps)
    const message = report?.error instanceof Error ? report.error.message : ''
    expect(reconcileReports(deps)).toHaveLength(1)
    expect(message).toContain(deps.membership.organizations[0]?.organizationId ?? 'missing')
    expect(message).toContain(text(started.body, 'id'))
    expect(message).not.toContain(email)
    expect(deps.logLines.join('\n')).not.toContain(email)
  })

  test('a double submit where one insert throws and the other commits ends with a live Organization and no abandon', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    // Request B is held between its call to core and its insert, until request A has finished.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let coreCalls = 0
    const createOrganization = deps.membership.createOrganization.bind(deps.membership)
    deps.membership.createOrganization = async (input) => {
      coreCalls += 1
      const mine = coreCalls
      const created = await createOrganization(input)
      if (mine === 2) {
        await gate
      }
      return created
    }
    // The first insert to be attempted (A's) throws; the held one (B's) is the second.
    let inserts = 0
    const create = deps.users.create.bind(deps.users)
    deps.users.create = async (input) => {
      inserts += 1
      if (inserts === 1) {
        throw new Error('connection reset')
      }
      return create(input)
    }

    const first = verify(started, code)
    const second = verify(started, code)
    while (coreCalls < 2) {
      await Bun.sleep(1)
    }
    const a = await first
    release()
    const b = await second

    expect(a.status).toBe(500)
    expect(b.status).toBe(200)
    expect(deps.membership.calls.abandon).toBe(0)
    const user = await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)
    expect(user).not.toBeNull()
    expect(await deps.membership.forUser(formatId('usr', user?.id ?? '') as UserId)).toMatchObject({
      role: 'owner',
      organizationStatus: 'active',
    })
  })

  test("the safe branch never abandons when the existing account is this attempt's own user", async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    const tenant = deps.tenant.current
    const attempt = await deps.flowAttempts.findById(
      tenant?.environmentId ?? '',
      text(started.body, 'id')
    )
    // A request of this same attempt already committed the account (same user id, same address).
    await deps.users.create({
      id: String(attempt?.state.userId),
      projectId: tenant?.projectId ?? '',
      environmentId: tenant?.environmentId ?? '',
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

    const done = await verify(started, code)

    expect(done.status).toBe(200)
    expect(deps.membership.calls.abandon).toBe(0)
    expect(reconcileReports(deps)).toHaveLength(0)
  })

  test('an address that belongs to a different user is abandoned once, with the case ids and key', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    loseAddress(deps, email)

    const lost = await verify(started, code)

    expect(lost.status).toBe(409)
    expect(lost.body).toMatchObject({ error: { code: 'flow.invalid_step' } })
    const org = deps.membership.organizations[0]
    if (!org) {
      throw new Error('no Organization was made')
    }
    expect(deps.membership.abandons).toEqual([
      {
        organizationId: org.organizationId,
        userId: org.owner,
        idempotencyKey: `abandon:${text(started.body, 'id')}`,
      },
    ])
    expect(reconcileReports(deps)).toHaveLength(0)
    expect(warnings(deps)).toContain('an Organization with no owner was abandoned')
    expect(deps.logLines.join('\n')).not.toContain(email)
  })

  describe('whatever core answers to the abandon, the sign-up answer is the same', () => {
    test('a refusal (409) is logged by ids, reported once, and never retried', async () => {
      const { deps, signUp, verify, nextEmail } = await setup()
      const email = nextEmail()
      const started = await signUp(email, { organizationName: 'Northline', firstName: 'Zebulon' })
      const code = emailedCode(deps, email)
      loseAddress(deps, email)
      deps.membership.refuseAbandons(true)

      const lost = await verify(started, code)

      expect(lost.status).toBe(409)
      expect(deps.membership.calls.abandon).toBe(1)
      expect(warnings(deps)).toContain('core refused to abandon an Organization')
      const reports = reconcileReports(deps)
      expect(reports).toHaveLength(1)
      const message = reports[0]?.error instanceof Error ? reports[0].error.message : ''
      expect(message).toContain(deps.membership.organizations[0]?.organizationId ?? 'missing')
      expect(message).toContain('refused')
      expect(`${message}${deps.logLines.join('\n')}`).not.toContain(email)
      expect(`${message}${deps.logLines.join('\n')}`).not.toContain('Zebulon')
    })

    test('a transient failure that clears on the second try is done and not reported', async () => {
      const { deps, signUp, verify, nextEmail } = await setup()
      const email = nextEmail()
      const started = await signUp(email)
      const code = emailedCode(deps, email)
      loseAddress(deps, email)
      deps.membership.failNextAbandons(1)

      const lost = await verify(started, code)

      expect(lost.status).toBe(409)
      expect(deps.membership.calls.abandon).toBe(2)
      expect(new Set(deps.membership.abandons.map((a) => a.idempotencyKey)).size).toBe(1)
      expect(reconcileReports(deps)).toHaveLength(0)
    })

    test('a transient failure that outlasts the tries is reported by ids', async () => {
      const { deps, signUp, verify, nextEmail } = await setup()
      const email = nextEmail()
      const started = await signUp(email)
      const code = emailedCode(deps, email)
      loseAddress(deps, email)
      deps.membership.failNextAbandons(100)

      const lost = await verify(started, code)

      expect(lost.status).toBe(409)
      expect(lost.body).toMatchObject({ error: { code: 'flow.invalid_step' } })
      expect(deps.membership.calls.abandon).toBe(3)
      expect(warnings(deps)).toContain('could not abandon an Organization')
      const reports = reconcileReports(deps)
      expect(reports).toHaveLength(1)
      const message = reports[0]?.error instanceof Error ? reports[0].error.message : ''
      expect(message).toContain(deps.membership.organizations[0]?.organizationId ?? 'missing')
      expect(message).toContain(text(started.body, 'id'))
      expect(message).not.toContain(email)
    })
  })

  test('a burned invitation is reported but never abandoned: the Organization has other members', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    deps.membership.invite('inv-1', {
      email,
      organizationId: `org_${'a'.repeat(32)}`,
      role: 'rep',
    })
    const started = await signUp(email, { invitationToken: 'inv-1' })
    const code = emailedCode(deps, email)
    breakInsert(deps)

    const failed = await verify(started, code)

    expect(failed.status).toBe(500)
    expect(deps.membership.calls.abandon).toBe(0)
    expect(reconcileReports(deps)).toHaveLength(1)
  })

  test('an Owner whose account was written is never abandoned', async () => {
    const { signedUp, deps } = await setup()

    await signedUp()

    expect(deps.membership.calls.abandon).toBe(0)
  })

  describe('the report to the tracker', () => {
    const orphan = { organizationId: 'org_1', userId: 'usr_1', attemptId: 'att_1', why: 'test' }
    function tracked() {
      const reports: unknown[] = []
      const context = {
        client: 'ios' as const,
        report: (error: unknown) => void reports.push(error),
      }
      return { reports, context }
    }

    test('is made again once the window has passed, and not before', async () => {
      const { deps } = await setup()
      const { reports, context } = tracked()

      await reportOrphan(deps, context, 500, orphan)
      deps.clock.advance('59m')
      await reportOrphan(deps, context, 500, orphan)
      expect(reports).toHaveLength(1)

      deps.clock.advance('2m')
      await reportOrphan(deps, context, 500, orphan)
      expect(reports).toHaveLength(2)
    })

    test('is suppressed when the limiter map is full, but the orphan is still logged with its ids', async () => {
      const { deps } = await setup()
      const { reports, context } = tracked()
      deps.rateLimiter = new MemoryRateLimiter(deps.clock, { maxKeys: 1 })
      await deps.rateLimiter.hit('filler', 1, ORPHAN_REPORT_WINDOW_MS)
      const before = deps.logLines.length

      await reportOrphan(deps, context, 500, orphan)
      await reportOrphan(deps, context, 500, orphan)

      expect(reports).toHaveLength(0)
      const lines = deps.logLines.slice(before).join('\n')
      expect(lines.split('an Organization has no owner')).toHaveLength(3)
      expect(lines).toContain('org_1')
    })
  })

  test('an attempt that expires while core is answering is not purged out from under the sign-up', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)
    const createOrganization = deps.membership.createOrganization.bind(deps.membership)
    deps.membership.createOrganization = async (input) => {
      const created = await createOrganization(input)
      // The attempt's ten minutes run out as core answers, and a purge runs right then.
      deps.clock.advance('10m')
      deps.clock.advance('1s')
      await Retention.purgeExpired(deps, Bootstrap.requireTenant(deps))
      return created
    }

    const done = await verify(started, code)

    expect(done.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })
})

describe('guards that must hold on their own', () => {
  test('a code is single-use: two verifications with one code at once give one session and one 409', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email)
    const code = emailedCode(deps, email)

    const replies = await Promise.all([verify(started, code), verify(started, code)])

    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409])
    expect(replies.find((reply) => reply.status === 409)?.body).toMatchObject({
      error: { code: 'flow.invalid_step' },
    })
    const user = await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)
    const sessions = await deps.sessions.listActive(
      deps.tenant.current?.environmentId ?? '',
      user?.id ?? '',
      deps.clock.now(),
      10
    )
    expect(sessions).toHaveLength(1)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test("an attempt of one kind is not accepted by the other kind's steps", async () => {
    const { app, signUp, nextEmail } = await setup()
    const signUpAttempt = await signUp(nextEmail())
    const signInAttempt = await call(app, 'POST', '/v1/client/sign-ins', {
      body: { identifier: nextEmail() },
    })

    const passwordOnSignUp = await call(
      app,
      'POST',
      `/v1/client/sign-ins/${text(signUpAttempt.body, 'id')}/password`,
      { attempt: text(signUpAttempt.body, 'attemptSecret'), body: { password: PASSWORD } }
    )
    const verifyOnSignIn = await call(
      app,
      'POST',
      `/v1/client/sign-ups/${text(signInAttempt.body, 'id')}/verify-email`,
      { attempt: text(signInAttempt.body, 'attemptSecret'), body: { code: '123456' } }
    )
    const resendOnSignIn = await call(
      app,
      'POST',
      `/v1/client/sign-ups/${text(signInAttempt.body, 'id')}/resend-code`,
      { attempt: text(signInAttempt.body, 'attemptSecret') }
    )

    for (const reply of [passwordOnSignUp, verifyOnSignIn, resendOnSignIn]) {
      expect(reply.status).toBe(404)
      expect(reply.body).toMatchObject({ error: { code: 'flow.not_found' } })
    }
  })

  test.each(['us', 'eu'] as const)(
    'the region in a token is the configured one (%s)',
    async (region) => {
      const deps = await createReadyDeps({ env: { REGION: region } })
      const app = createApp(deps)
      const email = 'region@northline.app'
      const started = await call(app, 'POST', '/v1/client/sign-ups', {
        body: { email, password: PASSWORD, organizationName: 'Northline' },
      })
      const done = await call(
        app,
        'POST',
        `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
        { attempt: text(started.body, 'attemptSecret'), body: { code: emailedCode(deps, email) } }
      )

      const claims = decodeJwt(text(done.body, 'session.accessToken'))

      expect(claims.region).toBe(region)
    }
  )
})

describe('a request that is shed is never counted against anyone', () => {
  /** Holds one slot of a limiter until `release` is called, so the limiter can be filled for real. */
  function fill(limiter: ConcurrencyLimiter, slots: number) {
    let release: () => void = () => {}
    const open = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = Array.from({ length: slots }, () => limiter.run(() => open))
    return { release: () => release(), done: Promise.all(held) }
  }

  async function sharedSetup() {
    const deps = await createReadyDeps({
      env: { HASH_CONCURRENCY: '1', HASH_QUEUE: '0', SIGN_IN_CONCURRENCY: '1', SIGN_IN_QUEUE: '0' },
    })
    const app = createApp(deps)
    const signUp = (email: string) =>
      call(app, 'POST', '/v1/client/sign-ups', {
        body: { email, password: PASSWORD, organizationName: 'Northline' },
      })
    const startSignIn = async (identifier: string) => {
      const started = await call(app, 'POST', '/v1/client/sign-ins', { body: { identifier } })
      return (password: string) =>
        call(app, 'POST', `/v1/client/sign-ins/${text(started.body, 'id')}/password`, {
          attempt: text(started.body, 'attemptSecret'),
          body: { password },
        })
    }
    return { deps, app, signUp, startSignIn }
  }

  test('six shed password submits leave the account unlocked: the right password then signs in', async () => {
    const { deps, app, signUp, startSignIn } = await sharedSetup()
    const email = 'shed@northline.app'
    const started = await signUp(email)
    await call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    })
    const password = await startSignIn(email)
    const full = fill(deps.limits.signIn, 1)

    const shed = []
    for (let n = 0; n < 6; n++) {
      shed.push(await password(`${PASSWORD}-wrong`))
    }
    full.release()
    await full.done
    const after = await password(PASSWORD)

    expect(shed.map((reply) => reply.status)).toEqual(Array(6).fill(503))
    expect(after.status).toBe(200)
  })

  test('a shed sign-up is not counted against the address: the retry is not rate limited', async () => {
    const { deps, signUp } = await sharedSetup()
    const full = fill(deps.limits.hash, 1)

    const shed = await signUp('retry@northline.app')
    full.release()
    await full.done
    const retried = await signUp('retry@northline.app')

    expect(shed.status).toBe(503)
    expect(retried.status).toBe(200)
  })

  test('a sign-up shed at the breach lookup is not counted against the address either', async () => {
    const { deps, signUp } = await sharedSetup()
    const full = fill(
      deps.limits.breach,
      deps.env.BREACH_CHECK_CONCURRENCY + deps.env.BREACH_CHECK_QUEUE
    )

    const shed = await signUp('breach@northline.app')
    full.release()
    await full.done
    const retried = await signUp('breach@northline.app')

    expect(shed.status).toBe(503)
    expect(retried.status).toBe(200)
  })

  test('a full sign-up lane sheds no sign-in', async () => {
    const { deps, app, signUp, startSignIn } = await sharedSetup()
    const email = 'lane@northline.app'
    const started = await signUp(email)
    await call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    })
    const password = await startSignIn(email)
    const full = fill(deps.limits.hash, 1)

    const signedIn = await password(PASSWORD)
    const shedSignUp = await signUp('other@northline.app')
    full.release()
    await full.done

    expect(signedIn.status).toBe(200)
    expect(shedSignUp.status).toBe(503)
  })

  test('a full sign-in lane sheds no sign-up', async () => {
    const { deps, signUp } = await sharedSetup()
    const full = fill(deps.limits.signIn, 1)

    const reply = await signUp('lane2@northline.app')
    full.release()
    await full.done

    expect(reply.status).toBe(200)
  })

  test('an unknown identifier is shed like a known one, and its dummy verify uses the sign-in lane', async () => {
    const { deps, startSignIn } = await sharedSetup()
    const password = await startSignIn('nobody@northline.app')
    const full = fill(deps.limits.signIn, 1)

    const shed = await password(PASSWORD)
    full.release()
    await full.done
    const after = await password(PASSWORD)

    expect(shed.status).toBe(503)
    expect(after.status).toBe(401)
  })
})

describe('what the per-process counters allow while they are full', () => {
  test('KNOWN LIMITATION: with every send bucket at its limit, a sign-up for a new address is refused', async () => {
    // The rate limiter never evicts a bucket at its limit (that would grant more sends), so a
    // flood that fills the cap with such buckets denies sign-up to addresses nobody has used.
    // Fixed by moving the counters to Postgres (hub issue 30); this pins the behaviour. The
    // 1-hour buckets exist only to hold the cap: the real cooldown bucket lasts 60 s.
    const { deps, signUp } = await setup()
    deps.rateLimiter = new MemoryRateLimiter(deps.clock, { maxKeys: 50 })
    for (let n = 0; n < 25; n++) {
      await deps.rateLimiter.hit(`filler${n}:cooldown`, 1, 3_600_000)
      await deps.rateLimiter.hit(`filler${n}:hourly`, 1, 3_600_000)
    }

    const reply = await signUp('newcomer@northline.app')

    expect(reply.status).toBe(429)
    expect(reply.body).toMatchObject({ error: { code: 'verification.too_many_attempts' } })
  })
})

describe('what core is told about the person (ADR 0015)', () => {
  const FIRST_AT_LIMIT = 'f'.repeat(100)
  const LAST_AT_LIMIT = 'l'.repeat(100)

  test.each([
    ['both names', { firstName: 'Maya', lastName: 'Rao' }, 'Maya Rao'],
    ['first only', { firstName: 'Maya' }, 'Maya'],
    ['last only', { lastName: 'Rao' }, 'Rao'],
    ['neither', {}, null],
    ['empty strings', { firstName: '', lastName: '' }, null],
    ['padded', { firstName: '  Maya  ', lastName: ' Rao ' }, 'Maya Rao'],
    [
      'both at the length limit',
      { firstName: FIRST_AT_LIMIT, lastName: LAST_AT_LIMIT },
      `${FIRST_AT_LIMIT} ${LAST_AT_LIMIT}`,
    ],
    ['a control character inside', { firstName: 'Ma\u0007ya', lastName: 'Rao' }, 'Ma ya Rao'],
  ])(
    'an Owner sign-up with %s sends the verified address and that name',
    async (_label, names, expected) => {
      const { deps, signUp, verify, nextEmail } = await setup()
      const email = nextEmail()
      const started = await signUp(email, { organizationName: 'Northline', ...names })

      const done = await verify(started, emailedCode(deps, email))

      expect(done.status).toBe(200)
      expect(deps.membership.profiles).toEqual([
        { userId: expect.stringMatching(/^usr_/), email, name: expected },
      ])
    }
  )

  test('the address sent is the verified one in the folded form, whatever case it was typed in', async () => {
    const { deps, signUp, verify } = await setup()
    const started = await signUp('  Maya.Rao@Northline.APP ', { organizationName: 'Northline' })

    const done = await verify(started, emailedCode(deps, 'maya.rao@northline.app'))

    expect(done.status).toBe(200)
    expect(deps.membership.profiles.map((p) => p.email)).toEqual(['maya.rao@northline.app'])
  })

  test.each([
    ['both names', { firstName: 'Rae', lastName: 'Pell' }, 'Rae Pell'],
    ['neither', {}, null],
    ['last only', { lastName: ' Pell ' }, 'Pell'],
  ])(
    'an invitation sign-up with %s sends the address and that name',
    async (_label, names, expected) => {
      const { deps, signUp, verify, nextEmail } = await setup()
      const email = nextEmail()
      deps.membership.invite('inv-1', {
        email,
        organizationId: `org_${'a'.repeat(32)}`,
        role: 'rep',
      })
      const started = await signUp(email, { invitationToken: 'inv-1', ...names })

      const done = await verify(started, emailedCode(deps, email))

      expect(done.status).toBe(200)
      expect(deps.membership.profiles).toEqual([
        { userId: expect.stringMatching(/^usr_/), email, name: expected },
      ])
    }
  )

  test('the name is never written to a log line or a report', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email, {
      organizationName: 'Northline',
      firstName: 'Zebulon',
      lastName: 'Quillfeather',
    })
    deps.users.create = async () => {
      throw new Error('connection reset')
    }
    deps.membership.refuseAbandons(true)

    await verify(started, emailedCode(deps, email))

    const everything = JSON.stringify([deps.logLines, deps.reported.map((r) => String(r.error))])
    expect(everything).not.toContain('Zebulon')
    expect(everything).not.toContain('Quillfeather')
    expect(everything).not.toContain(email)
  })

  test('a name that cannot be sent is logged by attempt id, never by value, and the sign-up still works', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email, {
      organizationName: 'Northline',
      firstName: '\u0007\u0007',
      lastName: '\u0001',
    })

    const done = await verify(started, emailedCode(deps, email))

    expect(done.status).toBe(200)
    expect(deps.membership.profiles.map((p) => p.name)).toEqual([null])
    const lines = deps.logLines.map((line) => JSON.parse(line) as Record<string, unknown>)
    const warning = lines.find(
      (l) => l.level === 40 && l.msg === 'a name could not be sent to core'
    )
    expect(warning).toMatchObject({ attemptId: text(started.body, 'id') })
    expect(deps.logLines.join('\n')).not.toContain('\\u0007')
    expect(deps.logLines.join('\n')).not.toContain('\u0007')
  })

  test('an absent or blank name is not logged as a fallback', async () => {
    const { deps, signUp, verify, nextEmail } = await setup()
    const email = nextEmail()
    const started = await signUp(email, { organizationName: 'Northline', firstName: '  ' })

    await verify(started, emailedCode(deps, email))

    expect(deps.logLines.join('\n')).not.toContain('a name could not be sent to core')
  })
})
