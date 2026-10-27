import { describe, expect, spyOn, test } from 'bun:test'
import { googleCompleteResponseSchema } from 'tula-closeline-contract'
import {
  FAKE_CLIENT_SECRET,
  type FakeAccount,
  type FakeVisit,
  type TokenFlaw,
} from '~/adapters/memory/oidc-provider'
import { createUnconfiguredOidcProvider } from '~/adapters/unconfigured/oidc-provider'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { at, call, emailedCode, type Reply, text } from '~/testing/client'

const ORIGIN = 'https://app.example.com'
const PASSWORD = 'correct horse battery'
const MAYA: FakeAccount = { sub: 'google-sub-maya', email: 'maya@northline.app', name: 'Maya Lin' }
const CALLBACK = '/v1/client/google/callback'

type Begun = { reply: Reply; cookie: string; url: string; state: string; id: string }

async function setup(options: { env?: Record<string, string> } = {}) {
  const deps = await createReadyDeps({ env: { SESSION_ALLOWED_ORIGINS: ORIGIN, ...options.env } })
  const app = createApp(deps)
  const cookieName = deps.env.ENVIRONMENT === 'local' ? 'tula_oidc' : '__Secure-tula_oidc'
  const environmentId = () => deps.tenant.current?.environmentId ?? ''

  async function begin(
    intent: 'sign_in' | 'sign_up' = 'sign_in',
    returnTo?: string
  ): Promise<Begun> {
    const reply = await call(app, 'POST', '/v1/client/google/start', {
      // Outside local a request must name its source, as the proxy in front would.
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.50' },
      body: { intent, ...(returnTo === undefined ? {} : { returnTo }) },
    })
    const line = reply.headers.getSetCookie().find((entry) => entry.startsWith(`${cookieName}=`))
    const cookie = line?.split(';')[0] ?? ''
    const url = reply.status === 200 ? text(reply.body, 'authorizationUrl') : ''
    const state = url === '' ? '' : (new URL(url).searchParams.get('state') ?? '')
    return { reply, cookie, url, state, id: state.split('.')[0] ?? '' }
  }

  /** The person approves (or not) at Google, and the browser comes back to the callback. */
  async function callbackFor(
    begun: Begun,
    visit: FakeVisit,
    opts: { cookie?: string | null; query?: (params: URLSearchParams) => void } = {}
  ) {
    const params = await deps.oidc.visit(begun.url, visit)
    opts.query?.(params)
    const cookie = opts.cookie === undefined ? begun.cookie : opts.cookie
    return call(app, 'GET', `${CALLBACK}?${params}`, {
      headers: cookie === null ? {} : { cookie },
    })
  }

  const complete = (body: unknown, cookie: string | null, origin: string | null = ORIGIN) =>
    call(app, 'POST', '/v1/client/google/complete', {
      body,
      headers: {
        ...(cookie === null ? {} : { cookie }),
        ...(origin === null ? {} : { origin }),
      } as Record<string, string>,
    })

  /** A new Google person up to the sign-up step: the attempt id and cookie. */
  async function pending(account: FakeAccount = MAYA) {
    const begun = await begin('sign_up')
    const back = await callbackFor(begun, { account })
    const attemptId = new URL(back.headers.get('location') ?? '', ORIGIN).searchParams.get(
      'attempt'
    )
    return { begun, back, attemptId: attemptId ?? '' }
  }

  /** A signed-in Google user (sign-up completed). */
  async function googleUser(account: FakeAccount = MAYA) {
    const p = await pending(account)
    const done = await complete(
      { attemptId: p.attemptId, organizationName: 'Northline' },
      p.begun.cookie
    )
    return { ...p, done }
  }

  /** A user with a password, made by the email sign-up. */
  async function passwordUser(email = 'maya@northline.app') {
    const started = await call(app, 'POST', '/v1/client/sign-ups', {
      client: 'browser',
      body: { email, password: PASSWORD, organizationName: 'Northline' },
    })
    await call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      client: 'browser',
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    })
  }

  const errorOf = (reply: Reply) =>
    new URL(reply.headers.get('location') ?? '', ORIGIN).searchParams.get('error')
  const userByEmail = (email: string) => deps.users.findByEmail(environmentId(), email)
  const attempt = (id: string) => deps.flowAttempts.findById(environmentId(), id)
  return {
    deps,
    app,
    begin,
    callbackFor,
    complete,
    pending,
    googleUser,
    passwordUser,
    errorOf,
    userByEmail,
    attempt,
    environmentId,
  }
}

const refreshLine = (reply: Reply) =>
  reply.headers.getSetCookie().find((line) => line.startsWith('__Secure-tula_refresh='))

describe('auth options', () => {
  test('say Google is on when it is set up', async () => {
    const { app } = await setup()
    const reply = await call(app, 'GET', '/v1/client/auth-options')
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ providers: { google: true } })
  })

  test('say Google is off when it is not', async () => {
    const { app, deps } = await setup()
    deps.oidc = Object.assign(deps.oidc, createUnconfiguredOidcProvider())
    const reply = await call(app, 'GET', '/v1/client/auth-options')
    expect(reply.body).toEqual({ providers: { google: false } })
  })
})

describe('when Google is off', () => {
  test('start, callback and complete answer oidc.disabled', async () => {
    const { app, deps, begin } = await setup()
    const begun = await begin()
    deps.oidc = Object.assign(deps.oidc, createUnconfiguredOidcProvider())

    const start = await call(app, 'POST', '/v1/client/google/start', {
      headers: { origin: ORIGIN },
      body: { intent: 'sign_in' },
    })
    const back = await call(app, 'GET', `${CALLBACK}?code=c&state=${begun.state}`)
    const done = await call(app, 'POST', '/v1/client/google/complete', {
      headers: { origin: ORIGIN },
      body: { attemptId: begun.id, organizationName: 'Acme' },
    })

    for (const reply of [start, back, done]) {
      expect(reply.status).toBe(404)
      expect(reply.body).toMatchObject({ error: { code: 'oidc.disabled' } })
    }
  })
})

describe('start', () => {
  test('stores a hashed state, answers only the URL and sets the attempt cookie', async () => {
    const { begin, deps, attempt } = await setup()

    const begun = await begin('sign_in', '/members')

    expect(begun.reply.status).toBe(200)
    expect(Object.keys(begun.reply.body as object)).toEqual(['authorizationUrl'])
    const url = new URL(begun.url)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('prompt')).toBe('select_account')
    expect(url.searchParams.get('access_type')).toBeNull()
    expect(begun.state).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
    const stored = await attempt(begun.id)
    expect(stored).toMatchObject({
      kind: 'sign_in',
      status: 'oidc_started',
      identifier: 'google:pending',
    })
    const dump = JSON.stringify(stored)
    const [, random] = begun.state.split('.')
    for (const secret of [random, url.searchParams.get('nonce'), begun.cookie.split('=')[1]]) {
      expect(dump).not.toContain(secret ?? 'missing')
    }
    expect(stored?.state).toMatchObject({ returnTo: '/members' })
    expect(deps.logLines.join('\n')).not.toContain(random ?? 'missing')
  })

  test('sets the cookie with the contract attributes, in local and outside it', async () => {
    const local = await setup()
    const dev = await setup({ env: { ENVIRONMENT: 'dev' } })

    const localCookie = (await local.begin()).reply.headers.getSetCookie()[0]
    const devCookie = (await dev.begin()).reply.headers.getSetCookie()[0]

    expect(localCookie).toMatch(
      /^tula_oidc=tula_oi_[\w-]+; Path=\/v1\/client\/google\/; Max-Age=600; HttpOnly; SameSite=Lax$/
    )
    expect(devCookie).toMatch(
      /^__Secure-tula_oidc=tula_oi_[\w-]+; Path=\/v1\/client\/google\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/
    )
  })

  test('refuses a missing or foreign Origin', async () => {
    const { app } = await setup()
    for (const headers of [{}, { origin: 'https://evil.example.com' }] as Record<
      string,
      string
    >[]) {
      const reply = await call(app, 'POST', '/v1/client/google/start', {
        headers,
        body: { intent: 'sign_in' },
      })
      expect(reply.status).toBe(403)
      expect(reply.body).toMatchObject({ error: { code: 'auth.forbidden' } })
      expect(reply.headers.getSetCookie()).toEqual([])
    }
  })

  test.each(['//evil.example.com', '/\\evil.example.com', 'https://evil.example.com/'])(
    'refuses returnTo %p',
    async (returnTo) => {
      const { begin } = await setup()
      const begun = await begin('sign_in', returnTo)
      expect(begun.reply.status).toBe(400)
      expect(begun.reply.body).toMatchObject({ error: { code: 'request.invalid' } })
    }
  )

  test('replaces a returnTo that is not a portal route with the default', async () => {
    const { begin, attempt } = await setup()
    const begun = await begin('sign_in', '/not-a-portal-route')
    const stored = await attempt(begun.id)
    expect(stored?.state).toMatchObject({ returnTo: '/' })
  })

  test('is limited per source', async () => {
    const { app } = await setup()
    let last: Reply | undefined
    for (let n = 0; n < 21; n += 1) {
      last = await call(app, 'POST', '/v1/client/google/start', {
        headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.9' },
        body: { intent: 'sign_in' },
      })
    }
    expect(last?.status).toBe(429)
    const other = await call(app, 'POST', '/v1/client/google/start', {
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10' },
      body: { intent: 'sign_in' },
    })
    expect(other.status).toBe(200)
  })

  describe('the source of a request', () => {
    const startFrom = (app: Awaited<ReturnType<typeof setup>>['app'], forwarded?: string) =>
      call(app, 'POST', '/v1/client/google/start', {
        headers: {
          origin: ORIGIN,
          ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }),
        },
        body: { intent: 'sign_in' },
      })
    const exhaust = async (
      app: Awaited<ReturnType<typeof setup>>['app'],
      forwarded: (n: number) => string | undefined
    ) => {
      let last: Reply | undefined
      for (let n = 0; n < 21; n += 1) {
        last = await startFrom(app, forwarded(n))
      }
      return last
    }

    test('with TRUSTED_PROXY_HOPS=2 the client is the second hop from the right, whatever leads', async () => {
      const { app } = await setup({ env: { TRUSTED_PROXY_HOPS: '2' } })

      // One client, a different forged leading hop on every call: still one bucket.
      const blocked = await exhaust(app, (n) => `10.0.0.${n}, 203.0.113.1, 198.51.100.1`)

      expect(blocked?.status).toBe(429)
      expect((await startFrom(app, 'forged, 203.0.113.1, 198.51.100.1')).status).toBe(429)
      // Another client behind the same proxies has a bucket of its own.
      expect((await startFrom(app, '203.0.113.2, 198.51.100.1')).status).toBe(200)
    })

    test('outside local, a header with fewer hops than trusted, or none, is refused and logged once', async () => {
      const { app, deps } = await setup({ env: { ENVIRONMENT: 'dev', TRUSTED_PROXY_HOPS: '2' } })

      for (const forwarded of [undefined, '1.2.3.4', undefined]) {
        const reply = await startFrom(app, forwarded)
        expect(reply.status).toBe(400)
        expect(reply.body).toMatchObject({ error: { code: 'request.invalid' } })
      }
      expect(deps.logLines.filter((line) => line.includes('X-Forwarded-For'))).toHaveLength(1)
      expect((await startFrom(app, '203.0.113.2, 198.51.100.1')).status).toBe(200)
    })

    test('outside local, auth-options refuses a request with no header', async () => {
      const { app } = await setup({ env: { ENVIRONMENT: 'dev' } })

      const options = await call(app, 'GET', '/v1/client/auth-options')
      expect(options.status).toBe(400)
      expect(options.body).toMatchObject({ error: { code: 'request.invalid' } })
    })

    test('outside local, the callback redirects a request with no header to sign-in', async () => {
      const { app } = await setup({ env: { ENVIRONMENT: 'dev' } })

      const back = await call(app, 'GET', `${CALLBACK}?code=abc&state=xyz`)
      expect(back.status).toBe(302)
      expect(back.headers.get('location')).toBe('/sign-in?error=request.invalid')
    })

    test('in local, a header with fewer hops than trusted, or none, shares one bucket', async () => {
      const { app } = await setup({ env: { TRUSTED_PROXY_HOPS: '2' } })

      const blocked = await exhaust(app, (n) => (n % 2 === 0 ? undefined : `10.0.0.${n}`))

      expect(blocked?.status).toBe(429)
      expect((await startFrom(app, '203.0.113.2, 198.51.100.1')).status).toBe(200)
    })

    test('by default one proxy is trusted: the last hop', async () => {
      const { app } = await setup()
      const blocked = await exhaust(app, () => 'forged, 203.0.113.7')
      expect(blocked?.status).toBe(429)
      expect((await startFrom(app, 'forged, 203.0.113.8')).status).toBe(200)
    })
  })

  test('answers oidc.provider_unavailable with Retry-After when Google cannot be reached', async () => {
    const { app, deps } = await setup()
    deps.oidc.failNext('discovery', 503, 3)
    const reply = await call(app, 'POST', '/v1/client/google/start', {
      headers: { origin: ORIGIN },
      body: { intent: 'sign_in' },
    })
    expect(reply.status).toBe(503)
    expect(reply.body).toMatchObject({ error: { code: 'oidc.provider_unavailable' } })
    expect(reply.headers.get('retry-after')).toBe('5')
  })
})

describe('callback: a new person', () => {
  test('creates nothing and sends them to the sign-up step', async () => {
    const { begin, callbackFor, deps, userByEmail, attempt } = await setup()
    const begun = await begin('sign_up')

    const back = await callbackFor(begun, { account: MAYA })

    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe(`/sign-up/google?attempt=${begun.id}`)
    expect(back.headers.getSetCookie()).toEqual([])
    expect(await userByEmail('maya@northline.app')).toBeNull()
    expect(deps.membership.calls.create).toBe(0)
    const stored = await attempt(begun.id)
    expect(stored).toMatchObject({ status: 'oidc_pending', identifier: 'maya@northline.app' })
    const dump = JSON.stringify(stored)
    expect(dump).not.toContain('google-sub-maya')
    expect(dump).not.toContain('Maya Lin')
  })

  test('completes with an Organization name: user, Google identity and session, no credential', async () => {
    const { googleUser, deps, environmentId, userByEmail, attempt } = await setup()

    const { done, attemptId } = await googleUser()

    expect(done.status).toBe(200)
    expect(googleCompleteResponseSchema.safeParse(done.body).success).toBe(true)
    expect(at(done.body, 'step')).toEqual({ status: 'complete' })
    expect(at(done.body, 'kind')).toBe('sign_up')
    expect(JSON.stringify(done.body)).not.toContain('refreshToken')
    const refresh = refreshLine(done)
    expect(refresh).toContain('Path=/v1/client/sessions/')
    expect(refresh).toContain('SameSite=Strict')
    expect(done.headers.getSetCookie().some((line) => line.startsWith('tula_oidc=;'))).toBe(true)
    const user = await userByEmail('maya@northline.app')
    expect(user).toMatchObject({ firstName: 'Maya Lin', emailVerifiedAt: expect.any(Date) })
    expect(
      (await deps.users.findByEmailWithPassword(environmentId(), 'maya@northline.app'))
        ?.passwordHash
    ).toBeNull()
    expect((await deps.users.findByGoogleSubject(environmentId(), MAYA.sub))?.id).toBe(
      user?.id ?? ''
    )
    expect(deps.membership.organizations.map((o) => o.name)).toEqual(['Northline'])
    expect(deps.membership.profiles[0]).toMatchObject({ email: 'maya@northline.app' })
    expect((await attempt(attemptId))?.status).toBe('complete')
    expect(JSON.stringify(await attempt(attemptId))).not.toContain('google-sub-maya')
  })

  test('the issued access token works and belongs to the Owner of the new Organization', async () => {
    const { googleUser, app } = await setup()
    const { done } = await googleUser()
    const me = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(done.body, 'session.accessToken'),
    })
    expect(me.body).toMatchObject({ email: 'maya@northline.app', organization: { role: 'owner' } })
  })

  test('joins an Invitation sent to the Google address', async () => {
    const { pending, complete, deps } = await setup()
    const organizationId = `org_${'a'.repeat(32)}`
    deps.membership.invite('inv-1', { email: 'maya@northline.app', organizationId, role: 'rep' })
    const p = await pending()

    const done = await complete(
      { attemptId: p.attemptId, invitationToken: 'inv-1' },
      p.begun.cookie
    )

    expect(done.status).toBe(200)
    expect(at(done.body, 'session.organization')).toEqual({ id: organizationId, role: 'rep' })
    expect(deps.membership.organizations).toEqual([])
  })

  test('an Invitation for another address is oidc.invitation_mismatch and the attempt stays usable', async () => {
    const { pending, complete, deps, attempt } = await setup()
    const organizationId = `org_${'a'.repeat(32)}`
    deps.membership.invite('inv-2', { email: 'someone@else.app', organizationId, role: 'rep' })
    const p = await pending()

    const refused = await complete(
      { attemptId: p.attemptId, invitationToken: 'inv-2' },
      p.begun.cookie
    )

    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ error: { code: 'oidc.invitation_mismatch' } })
    expect((await attempt(p.attemptId))?.status).toBe('oidc_pending')
    const retry = await complete(
      { attemptId: p.attemptId, organizationName: 'Northline' },
      p.begun.cookie
    )
    expect(retry.status).toBe(200)
  })
})

describe('callback: a returning user', () => {
  test('signs in by sub, ignores a changed email, and sets the refresh cookie on the 302', async () => {
    const { googleUser, begin, callbackFor, app, deps, errorOf } = await setup()
    await googleUser()
    const begun = await begin('sign_in', '/members')

    const back = await callbackFor(begun, { account: { ...MAYA, email: 'maya.new@elsewhere.app' } })

    expect(errorOf(back)).toBeNull()
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/members')
    const refresh = refreshLine(back)
    expect(refresh).toMatch(/^__Secure-tula_refresh=tula_rt_/)
    expect(back.headers.getSetCookie().some((line) => line.startsWith('tula_oidc=;'))).toBe(true)
    expect(back.headers.get('location')).not.toMatch(/token/i)
    const token = refresh?.split(';')[0]?.split('=')[1] ?? ''
    const refreshed = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { origin: ORIGIN, cookie: `__Secure-tula_refresh=${token}` },
    })
    expect(refreshed.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('a user of another Google account with the same address is refused neutrally', async () => {
    const { googleUser, begin, callbackFor, errorOf } = await setup()
    await googleUser()
    const begun = await begin()

    const back = await callbackFor(begun, { account: { ...MAYA, sub: 'a-different-sub' } })

    expect(back.status).toBe(302)
    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(refreshLine(back)).toBeUndefined()
  })
})

describe('callback: linking by address', () => {
  test('links a password account (any letter case), keeps the password, records the link', async () => {
    const { passwordUser, begin, callbackFor, errorOf, deps, environmentId, app } = await setup()
    await passwordUser('maya@northline.app')
    const begun = await begin()

    const back = await callbackFor(begun, { account: { ...MAYA, email: 'Maya@Northline.APP' } })

    expect(errorOf(back)).toBeNull()
    expect(refreshLine(back)).toBeString()
    expect((await deps.users.findByGoogleSubject(environmentId(), MAYA.sub))?.emailNormalized).toBe(
      'maya@northline.app'
    )
    expect(deps.users.links).toHaveLength(1)
    const signIn = await call(app, 'POST', '/v1/client/sign-ins', {
      client: 'ios',
      body: { identifier: 'maya@northline.app' },
    })
    const password = await call(
      app,
      'POST',
      `/v1/client/sign-ins/${text(signIn.body, 'id')}/password`,
      { attempt: text(signIn.body, 'attemptSecret'), body: { password: PASSWORD } }
    )
    expect(password.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('does not link a second Google account to a user who already has one', async () => {
    const { passwordUser, begin, callbackFor, errorOf, deps, environmentId } = await setup()
    await passwordUser()
    await callbackFor(await begin(), { account: MAYA })

    const back = await callbackFor(await begin(), { account: { ...MAYA, sub: 'second-sub' } })

    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(await deps.users.findByGoogleSubject(environmentId(), 'second-sub')).toBeNull()
  })

  test('does not link a user who has no password', async () => {
    const { googleUser, begin, callbackFor, errorOf, deps } = await setup()
    await googleUser()
    // The same address from a second Google account: the user has no password, so no link.
    const back = await callbackFor(await begin(), { account: { ...MAYA, sub: 'other' } })
    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(deps.users.links).toHaveLength(0)
  })

  test('does not link a banned user and does not say so', async () => {
    const { passwordUser, begin, callbackFor, errorOf, deps, userByEmail } = await setup()
    await passwordUser()
    deps.users.ban((await userByEmail('maya@northline.app'))?.id ?? '', deps.clock.now())

    const back = await callbackFor(await begin(), { account: MAYA })

    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(deps.users.links).toHaveLength(0)
  })

  test('refuses an address ADR 0011 cannot store (a Kelvin sign), without converting it', async () => {
    const { passwordUser, begin, callbackFor, errorOf, userByEmail } = await setup()
    await passwordUser('kelvin@northline.app')

    const back = await callbackFor(await begin(), {
      account: { sub: 'kelvin-sub', email: 'Kelvin@northline.app' },
    })

    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(await userByEmail('kelvin@northline.app')).not.toBeNull()
  })

  test('is not blocked by the password lockout and does not count towards it', async () => {
    const { passwordUser, begin, callbackFor, errorOf, app, deps } = await setup()
    await passwordUser()
    const wrong = async () => {
      const started = await call(app, 'POST', '/v1/client/sign-ins', {
        client: 'ios',
        body: { identifier: 'maya@northline.app' },
      })
      return call(app, 'POST', `/v1/client/sign-ins/${text(started.body, 'id')}/password`, {
        attempt: text(started.body, 'attemptSecret'),
        body: { password: 'definitely wrong password' },
      })
    }
    for (let n = 0; n < 8; n += 1) {
      await wrong()
    }
    expect((await wrong()).status).toBe(429)
    const attempts = spyOn(deps.lockout, 'attempt')

    const back = await callbackFor(await begin(), { account: MAYA })

    expect(errorOf(back)).toBeNull()
    expect(refreshLine(back)).toBeString()
    expect(attempts).not.toHaveBeenCalled()
  })
})

describe('callback: refusals', () => {
  test.each<TokenFlaw>([
    'bad_nonce',
    'bad_audience',
    'bad_issuer',
    'expired',
    'issued_in_future',
    'wrong_algorithm',
    'wrong_signing_key',
    'no_subject',
    'no_email',
    'no_nonce',
  ])('an ID token that is %p creates nothing and is oidc.state_invalid', async (flaw) => {
    const { begin, callbackFor, errorOf, userByEmail, deps } = await setup()

    const back = await callbackFor(await begin(), { account: MAYA, flaw })

    expect(back.status).toBe(302)
    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(refreshLine(back)).toBeUndefined()
    expect(await userByEmail('maya@northline.app')).toBeNull()
    expect(deps.membership.calls.create).toBe(0)
  })

  test('an unverified email is oidc.email_unverified', async () => {
    const { begin, callbackFor, errorOf } = await setup()
    const back = await callbackFor(await begin(), { account: MAYA, flaw: 'email_unverified' })
    expect(errorOf(back)).toBe('oidc.email_unverified')
  })

  test('Google error=access_denied is oidc.access_denied; any other error is provider_unavailable', async () => {
    const { begin, callbackFor, errorOf } = await setup()
    expect(errorOf(await callbackFor(await begin(), { error: 'access_denied' }))).toBe(
      'oidc.access_denied'
    )
    expect(errorOf(await callbackFor(await begin(), { error: 'server_error' }))).toBe(
      'oidc.provider_unavailable'
    )
  })

  test('neither code nor error is oidc.state_invalid', async () => {
    const { begin, callbackFor, errorOf } = await setup()
    const back = await callbackFor(
      await begin(),
      { account: MAYA },
      { query: (params) => params.delete('code') }
    )
    expect(errorOf(back)).toBe('oidc.state_invalid')
  })

  test('a banned user, a deleted Organization and an account with none are refused', async () => {
    const { googleUser, begin, callbackFor, errorOf, deps, userByEmail } = await setup()
    const { done } = await googleUser()
    const organizationId = text(done.body, 'session.organization.id')
    const user = await userByEmail('maya@northline.app')

    deps.membership.setOrganizationStatus(organizationId, 'deleted')
    expect(errorOf(await callbackFor(await begin(), { account: MAYA }))).toBe(
      'organization.deleted'
    )
    deps.membership.setOrganizationStatus(organizationId, 'active')

    deps.membership.forget(`usr_${user?.id.replaceAll('-', '')}` as never)
    expect(errorOf(await callbackFor(await begin(), { account: MAYA }))).toBe(
      'auth.no_organization'
    )

    deps.users.ban(user?.id ?? '', deps.clock.now())
    expect(errorOf(await callbackFor(await begin(), { account: MAYA }))).toBe('auth.user_banned')
  })

  test('core being down is membership.unavailable and a retry needs a fresh start', async () => {
    const { googleUser, begin, callbackFor, errorOf, deps } = await setup()
    await googleUser()
    deps.membership.breakDown(true)
    const begun = await begin()

    const back = await callbackFor(begun, { account: MAYA })

    expect(errorOf(back)).toBe('membership.unavailable')
    expect(refreshLine(back)).toBeUndefined()
    deps.membership.breakDown(false)
    const again = await callbackFor(await begin(), { account: MAYA })
    expect(refreshLine(again)).toBeString()
  })
})

describe('callback: the state and the cookie', () => {
  test('a replayed callback is oidc.state_invalid and Google is asked once', async () => {
    const { begin, deps, app, errorOf } = await setup()
    const begun = await begin()
    const params = await deps.oidc.visit(begun.url, { account: MAYA })
    const headers = { cookie: begun.cookie }

    const first = await call(app, 'GET', `${CALLBACK}?${params}`, { headers })
    const second = await call(app, 'GET', `${CALLBACK}?${params}`, { headers })

    expect(first.headers.get('location')).toStartWith('/sign-up/google')
    expect(second.status).toBe(302)
    expect(errorOf(second)).toBe('oidc.state_invalid')
    expect(deps.oidc.tokenRequests).toHaveLength(1)
  })

  test('the state is spent even when the verification fails', async () => {
    const { begin, deps, app, errorOf } = await setup()
    const begun = await begin()
    const params = await deps.oidc.visit(begun.url, { account: MAYA, flaw: 'bad_audience' })
    const headers = { cookie: begun.cookie }

    const first = await call(app, 'GET', `${CALLBACK}?${params}`, { headers })
    const second = await call(app, 'GET', `${CALLBACK}?${params}`, { headers })

    expect(errorOf(first)).toBe('oidc.state_invalid')
    expect(errorOf(second)).toBe('oidc.state_invalid')
    expect(deps.oidc.tokenRequests).toHaveLength(1)
  })

  test('a wrong state, a missing cookie and another attempt’s cookie are refused and spend nothing', async () => {
    const { begin, callbackFor, errorOf, attempt } = await setup()
    const begun = await begin()
    const other = await begin()

    const wrongState = await callbackFor(
      begun,
      { account: MAYA },
      {
        query: (params) => params.set('state', `${begun.id}.${'A'.repeat(43)}`),
      }
    )
    const noCookie = await callbackFor(begun, { account: MAYA }, { cookie: null })
    const foreign = await callbackFor(begun, { account: MAYA }, { cookie: other.cookie })
    const unknown = await callbackFor(
      begun,
      { account: MAYA },
      {
        query: (params) => params.set('state', 'not-a-state'),
      }
    )

    for (const reply of [wrongState, noCookie, foreign, unknown]) {
      expect(reply.status).toBe(302)
      expect(errorOf(reply)).toBe('oidc.state_invalid')
      // A foreign request must not clear the cookie of the person's own flow.
      expect(reply.headers.getSetCookie()).toEqual([])
    }
    expect((await attempt(begun.id))?.status).toBe('oidc_started')
    const good = await callbackFor(begun, { account: MAYA })
    expect(good.headers.get('location')).toStartWith('/sign-up/google')
  })

  test('an expired attempt is oidc.state_invalid', async () => {
    const { begin, errorOf, deps, app } = await setup()
    const begun = await begin()
    const query = await deps.oidc.visit(begun.url, { account: MAYA })
    deps.clock.advance('11m')

    const back = await call(app, 'GET', `${CALLBACK}?${query}`, {
      headers: { cookie: begun.cookie },
    })

    expect(errorOf(back)).toBe('oidc.state_invalid')
    expect(deps.oidc.tokenRequests).toHaveLength(0)
  })

  test('the attempt cookie is cleared once the attempt is spent, even when the code is refused', async () => {
    const { begin, callbackFor } = await setup()

    const back = await callbackFor(await begin(), { account: MAYA, flaw: 'bad_audience' })

    expect(back.headers.getSetCookie().some((line) => line.startsWith('tula_oidc=;'))).toBe(true)
  })

  test('the attempt cookie opens nothing in the password or email flows', async () => {
    const { begin, app } = await setup()
    const begun = await begin('sign_in')
    const secret = begun.cookie.split('=')[1] ?? ''

    const password = await call(app, 'POST', `/v1/client/sign-ins/${begun.id}/password`, {
      attempt: secret,
      body: { password: PASSWORD },
    })
    const verify = await call(app, 'POST', `/v1/client/sign-ups/${begun.id}/verify-email`, {
      attempt: secret,
      body: { code: '123456' },
    })

    expect(password.body).toMatchObject({ error: { code: 'flow.not_found' } })
    expect(verify.body).toMatchObject({ error: { code: 'flow.not_found' } })
  })

  test('is limited per source and answers with a redirect', async () => {
    const { app, errorOf } = await setup()
    let last: Reply | undefined
    for (let n = 0; n < 31; n += 1) {
      last = await call(app, 'GET', `${CALLBACK}?code=x&state=y`, {
        headers: { 'x-forwarded-for': '198.51.100.7' },
      })
    }
    expect(last?.status).toBe(302)
    expect(errorOf(last as Reply)).toBe('rate.limited')
  })
})

describe('complete', () => {
  test('needs the cookie, an allowed Origin and the right attempt', async () => {
    const { pending, complete, attempt } = await setup()
    const p = await pending()
    const other = await pending({ ...MAYA, sub: 'sub-2', email: 'two@northline.app' })
    const body = { attemptId: p.attemptId, organizationName: 'Northline' }

    const noCookie = await complete(body, null)
    const wrongCookie = await complete(body, other.begun.cookie)
    const noOrigin = await complete(body, p.begun.cookie, null)
    const unknown = await complete({ ...body, attemptId: crypto.randomUUID() }, p.begun.cookie)
    const notUuid = await complete({ ...body, attemptId: 'abc' }, p.begun.cookie)

    for (const reply of [noCookie, wrongCookie, unknown, notUuid]) {
      expect(reply.status).toBe(400)
      expect(reply.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    }
    expect(noOrigin.status).toBe(403)
    expect((await attempt(p.attemptId))?.status).toBe('oidc_pending')
  })

  test('another person’s attempt cannot be completed with a session of another Organization', async () => {
    const { pending, complete, googleUser, deps, environmentId, attempt } = await setup()
    // A is signed up with their own Organization; B is still at the sign-up step.
    const a = await googleUser({ ...MAYA, sub: 'sub-a', email: 'a@one.app' })
    const b = await pending({ ...MAYA, sub: 'sub-b', email: 'b@two.app' })

    const reply = await complete(
      { attemptId: b.attemptId, organizationName: 'Stolen' },
      a.begun.cookie
    )

    expect(reply.status).toBe(400)
    expect(deps.membership.organizations.map((o) => o.name)).toEqual(['Northline'])
    expect(await deps.flowAttempts.findById('another-environment', b.attemptId)).toBeNull()
    expect((await attempt(b.attemptId))?.environmentId).toBe(environmentId())
  })

  test('a second complete is oidc.state_invalid and creates nothing twice', async () => {
    const { googleUser, complete, deps } = await setup()
    const { attemptId, begun } = await googleUser()

    const again = await complete({ attemptId, organizationName: 'Northline' }, begun.cookie)

    expect(again.status).toBe(400)
    expect(again.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('two simultaneous completes make one user', async () => {
    const { pending, complete, deps } = await setup()
    const p = await pending()
    const body = { attemptId: p.attemptId, organizationName: 'Northline' }

    const replies = await Promise.all([
      complete(body, p.begun.cookie),
      complete(body, p.begun.cookie),
    ])

    expect(replies.map((r) => r.status).sort()).toEqual([200, 400])
    expect(deps.membership.organizations).toHaveLength(1)
    // The loser lost a race for the same account: it must not abandon the winner's Organization.
    expect(deps.membership.abandons).toEqual([])
    expect(deps.reported).toEqual([])
  })

  test('a lost race for the same account never abandons the winner’s Organization', async () => {
    const { pending, complete, deps } = await setup()
    const p = await pending()
    const write = deps.users.createGoogleUser.bind(deps.users)
    // The winner commits between the loser's checks and its write: the loser's write conflicts.
    spyOn(deps.users, 'createGoogleUser').mockImplementationOnce(async (user) => {
      await write(user)
      return write(user)
    })

    const reply = await complete(
      { attemptId: p.attemptId, organizationName: 'Northline' },
      p.begun.cookie
    )

    expect(reply.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    expect(deps.membership.abandons).toEqual([])
    expect(deps.reported).toEqual([])
  })

  test('an attempt that expires while core answers is reported as an Organization with no owner, once', async () => {
    const { pending, complete, deps, userByEmail } = await setup()
    const organizationId = `org_${'a'.repeat(32)}`
    deps.membership.invite('inv-9', { email: 'maya@northline.app', organizationId, role: 'rep' })
    const p = await pending()
    const accept = deps.membership.acceptInvitation.bind(deps.membership)
    spyOn(deps.membership, 'acceptInvitation').mockImplementationOnce(async (input) => {
      const answer = await accept(input)
      deps.clock.advance('11m')
      return answer
    })
    const body = { attemptId: p.attemptId, invitationToken: 'inv-9' }

    const reply = await complete(body, p.begun.cookie)

    expect(reply.status).toBe(400)
    expect(reply.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    expect(refreshLine(reply)).toBeUndefined()
    expect(await userByEmail('maya@northline.app')).toBeNull()
    expect(deps.reported).toHaveLength(1)
    expect(String(deps.reported[0]?.error)).toContain('has no owner')
    // A retry is refused as expired and reports nothing more.
    await complete(body, p.begun.cookie)
    expect(deps.reported).toHaveLength(1)
  })

  test('an expired attempt is oidc.state_invalid', async () => {
    const { pending, complete, deps } = await setup()
    const p = await pending()
    deps.clock.advance('10m')
    deps.clock.advance('1s')

    const reply = await complete(
      { attemptId: p.attemptId, organizationName: 'Northline' },
      p.begun.cookie
    )

    expect(reply.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    expect(deps.membership.calls.create).toBe(0)
  })

  test('an address taken since the callback is refused before core is asked', async () => {
    const { pending, complete, passwordUser, deps } = await setup()
    const p = await pending()
    await passwordUser('maya@northline.app')
    const before = deps.membership.calls.create

    const reply = await complete(
      { attemptId: p.attemptId, organizationName: 'Northline' },
      p.begun.cookie
    )

    expect(reply.body).toMatchObject({ error: { code: 'oidc.state_invalid' } })
    expect(deps.membership.calls.create).toBe(before)
  })

  test('core being down is membership.unavailable; the retry gets the same Organization', async () => {
    const { pending, complete, deps, attempt } = await setup()
    const p = await pending()
    const body = { attemptId: p.attemptId, organizationName: 'Northline' }
    deps.membership.breakDown(true)

    const down = await complete(body, p.begun.cookie)

    expect(down.status).toBe(503)
    expect(down.body).toMatchObject({ error: { code: 'membership.unavailable' } })
    expect((await attempt(p.attemptId))?.status).toBe('oidc_pending')
    deps.membership.breakDown(false)
    const retry = await complete(body, p.begun.cookie)
    expect(retry.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('a crash after core succeeded and before the write leaves the attempt usable; the retry finishes with the same Organization', async () => {
    const { pending, complete, deps, attempt, userByEmail } = await setup()
    const p = await pending()
    const body = { attemptId: p.attemptId, organizationName: 'Northline' }
    const write = spyOn(deps.users, 'createGoogleUser').mockRejectedValueOnce(
      new Error('the process died')
    )

    const crashed = await complete(body, p.begun.cookie)

    expect(crashed.status).toBe(500)
    expect(deps.membership.organizations).toHaveLength(1)
    const organizationId = deps.membership.organizations[0]?.organizationId
    expect((await attempt(p.attemptId))?.status).toBe('oidc_pending')
    expect(await userByEmail('maya@northline.app')).toBeNull()
    write.mockRestore()

    const retry = await complete(body, p.begun.cookie)

    expect(retry.status).toBe(200)
    expect(at(retry.body, 'session.organization.id')).toBe(organizationId ?? '')
    expect(deps.membership.organizations).toHaveLength(1)
    expect(deps.membership.calls.create).toBe(2)
    expect((await attempt(p.attemptId))?.status).toBe('complete')
  })

  test('is capped per attempt', async () => {
    const { pending, complete, deps } = await setup()
    const p = await pending()
    deps.membership.breakDown(true)
    let last: Reply | undefined
    for (let n = 0; n < 6; n += 1) {
      last = await complete({ attemptId: p.attemptId, organizationName: 'Acme' }, p.begun.cookie)
    }
    expect(last?.status).toBe(429)
  })

  test('calls without the cookie do not spend the attempt’s budget', async () => {
    const { pending, complete } = await setup()
    const p = await pending()
    for (let n = 0; n < 8; n += 1) {
      await complete({ attemptId: p.attemptId, organizationName: 'Acme' }, 'tula_oidc=wrong')
    }

    const reply = await complete(
      { attemptId: p.attemptId, organizationName: 'Acme' },
      p.begun.cookie
    )

    expect(reply.status).toBe(200)
  })

  test('is limited per source', async () => {
    const { app } = await setup()
    let last: Reply | undefined
    for (let n = 0; n < 11; n += 1) {
      last = await call(app, 'POST', '/v1/client/google/complete', {
        headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.20' },
        body: { attemptId: crypto.randomUUID(), organizationName: 'Acme' },
      })
    }
    expect(last?.status).toBe(429)
  })

  test('rejects a body with neither or both of the Organization name and the Invitation', async () => {
    const { pending, complete } = await setup()
    const p = await pending()
    for (const extra of [{}, { organizationName: 'A', invitationToken: 'B' }]) {
      const reply = await complete({ attemptId: p.attemptId, ...extra }, p.begun.cookie)
      expect(reply.status).toBe(400)
    }
  })
})

describe('provider calls', () => {
  test('a 5xx or a network error on discovery is retried, twice at most', async () => {
    const { begin, deps } = await setup()
    deps.oidc.failNext('discovery', 502)
    deps.oidc.failNext('discovery', 'network')

    const begun = await begin()

    expect(begun.reply.status).toBe(200)
    expect(deps.oidc.requests.discovery).toBe(3)
  })

  test('a call that stalls is cut off at the bound and retried', async () => {
    const { begin, deps } = await setup()
    deps.oidc.stallNext('discovery')

    const begun = await begin()

    expect(begun.reply.status).toBe(200)
    expect(deps.oidc.requests.discovery).toBe(2)
  })

  test('discovery is cached', async () => {
    const { begin, deps } = await setup()
    await begin()
    await begin()
    expect(deps.oidc.requests.discovery).toBe(1)
  })

  test('the code exchange is not retried after Google answered', async () => {
    const { begin, callbackFor, errorOf, deps } = await setup()
    deps.oidc.failNext('token', 503)

    const back = await callbackFor(await begin(), { account: MAYA })

    expect(errorOf(back)).toBe('oidc.provider_unavailable')
    expect(deps.oidc.requests.token).toBe(1)
  })

  test('the code exchange is retried when no answer came back at all', async () => {
    const { begin, callbackFor, deps } = await setup()
    deps.oidc.failNext('token', 'network')

    const back = await callbackFor(await begin(), { account: MAYA })

    expect(back.headers.get('location')).toStartWith('/sign-up/google')
    expect(deps.oidc.requests.token).toBe(2)
  })

  test('the exchange sends the PKCE verifier, the client secret and the redirect URI', async () => {
    const { begin, callbackFor, deps } = await setup()
    await callbackFor(await begin(), { account: MAYA })
    const sent = deps.oidc.tokenRequests[0]
    expect(sent).toMatchObject({
      grant_type: 'authorization_code',
      client_secret: FAKE_CLIENT_SECRET,
      redirect_uri: 'https://app.example.com/v1/client/google/callback',
    })
    expect(sent?.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('the signing keys are cached, refetched on an unknown key id, and not more than once per cooldown', async () => {
    const { begin, callbackFor, errorOf, deps } = await setup()
    await callbackFor(await begin(), { account: MAYA })
    await callbackFor(await begin(), { account: { ...MAYA, sub: 'x', email: 'x@y.app' } })
    expect(deps.oidc.requests.jwks).toBe(1)

    await deps.oidc.rotateKey()
    const tooSoon = await callbackFor(await begin(), {
      account: { ...MAYA, sub: 'y', email: 'y@y.app' },
    })
    expect(errorOf(tooSoon)).toBe('oidc.state_invalid')
    expect(deps.oidc.requests.jwks).toBe(1)

    deps.clock.advance('31s')
    const later = await callbackFor(await begin(), {
      account: { ...MAYA, sub: 'z', email: 'z@y.app' },
    })
    expect(later.headers.get('location')).toStartWith('/sign-up/google')
    expect(deps.oidc.requests.jwks).toBe(2)
  })

  test('nothing secret is logged', async () => {
    const { begin, callbackFor, googleUser, deps } = await setup()
    const begun = await begin()
    const query = await deps.oidc.visit(begun.url, { account: MAYA })
    await callbackFor(begun, { account: MAYA, flaw: 'bad_nonce' })
    await googleUser({ ...MAYA, sub: 's2', email: 's2@x.app' })
    const log = deps.logLines.join('\n')
    for (const secret of [
      FAKE_CLIENT_SECRET,
      begun.cookie.split('=')[1],
      query.get('code'),
      begun.state.split('.')[1],
      new URL(begun.url).searchParams.get('nonce'),
    ]) {
      expect(log).not.toContain(secret ?? 'missing')
    }
  })
})
