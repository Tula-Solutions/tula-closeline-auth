import { describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { at, call, emailedCode, text } from '~/testing/client'

const PASSWORD = 'correct horse battery'
const ORIGIN = 'https://app.example.com'
const NAME = '__Secure-tula_refresh'
const PATH = '/v1/client/sessions/'
const ABSOLUTE_SECONDS = 30 * 24 * 60 * 60

type Options = { env?: Record<string, string>; name?: string }

/** The `name=value` pair a browser would send back, read from a response's `Set-Cookie`. */
function cookieOf(headers: Headers, name = NAME): string {
  const line = headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`))
  if (line === undefined) {
    throw new Error(`no ${name} cookie was set`)
  }
  return line.split(';')[0] ?? ''
}

/** The value of the refresh cookie a response set. */
function tokenOf(headers: Headers, name = NAME): string {
  return cookieOf(headers, name).slice(name.length + 1)
}

async function setup(options: Options = {}) {
  const deps = await createReadyDeps({
    env: { SESSION_ALLOWED_ORIGINS: ORIGIN, ...options.env },
  })
  const app = createApp(deps)
  const email = 'maya@northline.app'
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'browser',
    // Outside local a request must name its source, as the proxy in front would.
    headers: { 'x-forwarded-for': '203.0.113.5' },
    body: { email, password: PASSWORD, organizationName: 'Northline' },
  })
  const done = await call(
    app,
    'POST',
    `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
    {
      client: 'browser',
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    }
  )
  const browser = (path: string, headers: Record<string, string> = {}) =>
    call(app, 'POST', path, {
      client: 'browser',
      headers: { origin: ORIGIN, ...headers },
    })
  const refresh = (cookie: string, headers: Record<string, string> = {}) =>
    browser('/v1/client/sessions/refresh', { cookie, ...headers })
  const signOut = (cookie: string | undefined, headers: Record<string, string> = {}) =>
    browser('/v1/client/sessions/sign-out', cookie === undefined ? headers : { cookie, ...headers })
  const signIn = async () => {
    const attempt = await call(app, 'POST', '/v1/client/sign-ins', {
      client: 'browser',
      body: { identifier: email },
    })
    return call(app, 'POST', `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`, {
      client: 'browser',
      attempt: text(attempt.body, 'attemptSecret'),
      body: { password: PASSWORD },
    })
  }
  return { deps, app, email, started, done, refresh, signOut, signIn, browser }
}

describe('the browser client type sets the refresh token in a cookie', () => {
  test('sign-up verification sets the cookie with every attribute and omits the token from the body', async () => {
    const { done } = await setup()

    expect(done.status).toBe(200)
    const cookies = done.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toBe(
      `${NAME}=${tokenOf(done.headers)}; Path=${PATH}; Max-Age=${ABSOLUTE_SECONDS}; HttpOnly; Secure; SameSite=Strict`
    )
    expect(tokenOf(done.headers)).toMatch(/^tula_rt_[0-9a-f]{64}$/)
    expect(cookies[0]).not.toContain('Domain')
    expect(done.headers.get('cache-control')).toBe('no-store')
    expect(at(done.body, 'session.refreshToken')).toBeUndefined()
    expect(JSON.stringify(done.body)).not.toContain('tula_rt_')
    expect(text(done.body, 'session.accessToken').length).toBeGreaterThan(20)
    expect(text(done.body, 'session.accessTokenExpiresAt')).toBe('2026-01-01T00:01:00.000Z')
    expect(text(done.body, 'session.organization.role')).toBe('owner')
  })

  test('sign-in completion sets the cookie and omits the token from the body', async () => {
    const { signIn } = await setup()

    const reply = await signIn()

    expect(reply.status).toBe(200)
    // The refresh cookie, then the known-device cookie (ADR 0014), which has its own tests.
    const [refreshLine, deviceLine, ...others] = reply.headers.getSetCookie()
    expect(refreshLine).toBe(
      `${NAME}=${tokenOf(reply.headers)}; Path=${PATH}; Max-Age=${ABSOLUTE_SECONDS}; HttpOnly; Secure; SameSite=Strict`
    )
    expect(deviceLine).toStartWith('__Secure-tula_known_device=')
    expect(others).toEqual([])
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(at(reply.body, 'session.refreshToken')).toBeUndefined()
    expect(text(reply.body, 'session.accessToken').length).toBeGreaterThan(20)
  })

  test('a step that issues no session sets no cookie', async () => {
    const { app } = await setup()

    const started = await call(app, 'POST', '/v1/client/sign-ins', {
      client: 'browser',
      body: { identifier: 'maya@northline.app' },
    })

    expect(started.status).toBe(200)
    expect(started.headers.getSetCookie()).toEqual([])
  })

  test('the cookie is scoped to the refresh and sign-out routes only', () => {
    // Path=/v1/client/sessions/ matches /refresh and /sign-out, not /v1/client/sessions itself
    // (the list route) and no other prefix. The cookie's own Path attribute is pinned above.
    expect(PATH.endsWith('/')).toBe(true)
    expect('/v1/client/sessions/refresh'.startsWith(PATH)).toBe(true)
    expect('/v1/client/sessions/sign-out'.startsWith(PATH)).toBe(true)
    expect('/v1/client/sessions'.startsWith(PATH)).toBe(false)
  })

  test('local development may drop Secure and the prefix, and nothing else', async () => {
    const { done, refresh } = await setup({ env: { SESSION_COOKIE_INSECURE: 'true' } })

    expect(done.headers.getSetCookie()).toEqual([
      `tula_refresh=${tokenOf(done.headers, 'tula_refresh')}; Path=${PATH}; Max-Age=${ABSOLUTE_SECONDS}; HttpOnly; SameSite=Strict`,
    ])
    const next = await refresh(cookieOf(done.headers, 'tula_refresh'))
    expect(next.status).toBe(200)
    expect(next.headers.getSetCookie()[0]).toStartWith('tula_refresh=')
    expect(next.headers.getSetCookie()[0]).not.toContain('Secure')
  })

  test('a deployed environment always sets Secure and the prefix', async () => {
    const { done } = await setup({ env: { ENVIRONMENT: 'dev' } })

    expect(done.headers.getSetCookie()[0]).toContain(`${NAME}=`)
    expect(done.headers.getSetCookie()[0]).toContain('; Secure; SameSite=Strict')
  })
})

describe('refreshing with the cookie', () => {
  test('rotates the cookie and returns a new access token, with no refresh token in the body', async () => {
    const { deps, done, refresh } = await setup()
    deps.clock.advance('30s')

    const next = await refresh(cookieOf(done.headers))

    expect(next.status).toBe(200)
    expect(text(next.body, 'sessionId')).toBe(text(done.body, 'session.sessionId'))
    expect(text(next.body, 'accessToken')).not.toBe(text(done.body, 'session.accessToken'))
    expect(at(next.body, 'refreshToken')).toBeUndefined()
    expect(JSON.stringify(next.body)).not.toContain('tula_rt_')
    expect(tokenOf(next.headers)).not.toBe(tokenOf(done.headers))
    expect(next.headers.get('cache-control')).toBe('no-store')
    expect(next.headers.getSetCookie()).toEqual([
      `${NAME}=${tokenOf(next.headers)}; Path=${PATH}; Max-Age=${ABSOLUTE_SECONDS - 30}; HttpOnly; Secure; SameSite=Strict`,
    ])
    const third = await refresh(cookieOf(next.headers))
    expect(third.status).toBe(200)
  })

  test('Max-Age is the session’s remaining absolute lifetime, not a fresh 30 days', async () => {
    const { deps, done, refresh } = await setup()
    let cookie = cookieOf(done.headers)
    for (let day = 0; day < 4; day++) {
      deps.clock.advance('6d')
      const next = await refresh(cookie)
      expect(next.status).toBe(200)
      cookie = cookieOf(next.headers)
      expect(next.headers.getSetCookie()[0]).toContain(
        `Max-Age=${ABSOLUTE_SECONDS - (day + 1) * 6 * 24 * 60 * 60};`
      )
    }
  })

  test('a refresh token in the body is ignored: with no cookie it is refused', async () => {
    const { app, done } = await setup()
    const token = tokenOf(done.headers)

    const reply = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { origin: ORIGIN },
      body: { refreshToken: token },
    })

    expect(reply.status).toBe(401)
    expect(at(reply.body, 'error.code')).toBe('session.invalid_token')
    expect(reply.headers.getSetCookie()).toEqual([
      `${NAME}=; Path=${PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    ])
    // The token was not spent: the cookie still works.
    const ok = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { origin: ORIGIN, cookie: `${NAME}=${token}` },
    })
    expect(ok.status).toBe(200)
  })

  test('a token in the body or a header never wins over the cookie', async () => {
    const { app, done, refresh } = await setup()
    const first = await refresh(cookieOf(done.headers))
    const live = tokenOf(first.headers)

    const reply = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: {
        origin: ORIGIN,
        cookie: `${NAME}=tula_rt_${'0'.repeat(64)}`,
        authorization: `Bearer ${live}`,
        'x-tula-refresh-token': live,
      },
      body: { refreshToken: live },
    })

    expect(reply.status).toBe(401)
    expect(at(reply.body, 'error.code')).toBe('session.invalid_token')
  })

  test('a missing cookie is the answer an unknown refresh token gets', async () => {
    const { browser } = await setup()

    const reply = await browser('/v1/client/sessions/refresh')

    expect(reply.status).toBe(401)
    expect(at(reply.body, 'error.code')).toBe('session.invalid_token')
  })

  test('other cookies on the request are ignored and the right one is found among them', async () => {
    const { done, refresh } = await setup()

    const reply = await refresh(`theme=dark; ${cookieOf(done.headers)}; other=1`)

    expect(reply.status).toBe(200)
  })

  test('the old cookie replayed inside the grace window gets the same next cookie', async () => {
    const { deps, done, refresh } = await setup()
    const old = cookieOf(done.headers)
    const first = await refresh(old)
    deps.clock.advance('5s')

    const again = await refresh(old)

    expect(again.status).toBe(200)
    expect(tokenOf(again.headers)).toBe(tokenOf(first.headers))
  })

  test('the old cookie replayed after the grace window ends the session', async () => {
    const { deps, done, refresh } = await setup()
    const old = cookieOf(done.headers)
    const first = await refresh(old)
    deps.clock.advance('11s')

    const replay = await refresh(old)

    expect(replay.status).toBe(401)
    expect(at(replay.body, 'error.code')).toBe('session.reuse_detected')
    const after = await refresh(cookieOf(first.headers))
    expect(after.status).toBe(401)
    expect(at(after.body, 'error.code')).toBe('session.reuse_detected')
  })
})

describe('signing out with the cookie', () => {
  test('ends the session and clears the cookie with the same name, path and attributes', async () => {
    const { done, signOut, refresh } = await setup()

    const reply = await signOut(cookieOf(done.headers))

    expect(reply.status).toBe(204)
    expect(reply.headers.getSetCookie()).toEqual([
      `${NAME}=; Path=${PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    ])
    expect(reply.headers.get('cache-control')).toBe('no-store')
    const after = await refresh(cookieOf(done.headers))
    expect(at(after.body, 'error.code')).toBe('session.revoked')
  })

  test('clears the cookie whether or not the session was found', async () => {
    const { signOut } = await setup()
    const clear = `${NAME}=; Path=${PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

    const unknown = await signOut(`${NAME}=tula_rt_${'1'.repeat(64)}`)
    const garbage = await signOut(`${NAME}=nonsense`)
    const none = await signOut(undefined)

    for (const reply of [unknown, garbage, none]) {
      expect(reply.status).toBe(204)
      expect(reply.headers.getSetCookie()).toEqual([clear])
    }
  })

  test('a token in the body does not end a session: only the cookie is read', async () => {
    const { app, done, refresh } = await setup()

    const reply = await call(app, 'POST', '/v1/client/sessions/sign-out', {
      client: 'browser',
      headers: { origin: ORIGIN },
      body: { refreshToken: tokenOf(done.headers) },
    })

    expect(reply.status).toBe(204)
    const after = await refresh(cookieOf(done.headers))
    expect(after.status).toBe(200)
  })

  test('local development clears the unprefixed cookie without Secure', async () => {
    const { done, signOut } = await setup({ env: { SESSION_COOKIE_INSECURE: 'true' } })

    const reply = await signOut(cookieOf(done.headers, 'tula_refresh'))

    expect(reply.headers.getSetCookie()).toEqual([
      `tula_refresh=; Path=${PATH}; Max-Age=0; HttpOnly; SameSite=Strict`,
    ])
  })
})

describe('the Origin check on refresh and sign-out', () => {
  const refused: [string, Record<string, string>][] = [
    ['a foreign origin', { origin: 'https://evil.test' }],
    ['the literal null origin', { origin: 'null' }],
    ['a look-alike host', { origin: 'https://app.example.com.evil.test' }],
    ['a look-alike prefix host', { origin: 'https://evilapp.example.com' }],
    ['a different port', { origin: 'https://app.example.com:8443' }],
    ['http instead of https', { origin: 'http://app.example.com' }],
    ['a trailing slash', { origin: 'https://app.example.com/' }],
    ['a different case', { origin: 'https://APP.example.com' }],
    ['two origins', { origin: `${ORIGIN}, https://evil.test` }],
    ['an empty origin', { origin: '' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site same-site', { 'sec-fetch-site': 'same-site' }],
    ['Sec-Fetch-Site none', { 'sec-fetch-site': 'none' }],
    ['Sec-Fetch-Site empty', { 'sec-fetch-site': '' }],
  ]

  test.each(refused)('refresh refuses %s and the session is untouched', async (_name, headers) => {
    const { deps, done, refresh } = await setup()
    const cookie = cookieOf(done.headers)

    const reply = await refresh(cookie, headers)

    expect(reply.status).toBe(403)
    expect(at(reply.body, 'error.code')).toBe('auth.forbidden')
    expect(reply.headers.getSetCookie()).toEqual([])
    expect(JSON.stringify(reply.body)).not.toContain(tokenOf(done.headers))
    expect(deps.logLines.join('\n')).not.toContain(tokenOf(done.headers))
    // Not spent, not revoked: the same cookie still refreshes.
    expect((await refresh(cookie)).status).toBe(200)
  })

  test.each(refused)('sign-out refuses %s and the session is untouched', async (_name, headers) => {
    const { done, signOut, refresh } = await setup()
    const cookie = cookieOf(done.headers)

    const reply = await signOut(cookie, headers)

    expect(reply.status).toBe(403)
    expect(at(reply.body, 'error.code')).toBe('auth.forbidden')
    expect(reply.headers.getSetCookie()).toEqual([])
    expect((await refresh(cookie)).status).toBe(200)
  })

  test('a missing Origin is refused on both routes', async () => {
    const { app, done } = await setup()
    const cookie = cookieOf(done.headers)

    for (const path of ['/v1/client/sessions/refresh', '/v1/client/sessions/sign-out']) {
      const reply = await call(app, 'POST', path, { client: 'browser', headers: { cookie } })
      expect(reply.status).toBe(403)
      expect(at(reply.body, 'error.code')).toBe('auth.forbidden')
      expect(reply.headers.getSetCookie()).toEqual([])
    }
    const ok = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { cookie, origin: ORIGIN },
    })
    expect(ok.status).toBe(200)
  })

  test('the check runs before the token is looked at', async () => {
    const { browser } = await setup()

    const reply = await browser('/v1/client/sessions/refresh', {
      origin: 'https://evil.test',
      cookie: `${NAME}=nonsense`,
    })

    expect(reply.status).toBe(403)
    expect(at(reply.body, 'error.code')).toBe('auth.forbidden')
  })

  test('with no allowed origin configured every cookie request is refused', async () => {
    const { done } = await setup()
    const bare = await createReadyDeps()
    const app = createApp(bare)

    const reply = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { origin: ORIGIN, cookie: cookieOf(done.headers) },
    })

    expect(reply.status).toBe(403)
  })

  test('each of several allowed origins passes; Sec-Fetch-Site same-origin passes', async () => {
    const other = 'https://portal.example.com:8443'
    const { done, refresh } = await setup({
      env: { SESSION_ALLOWED_ORIGINS: `${ORIGIN}, ${other}` },
    })
    let cookie = cookieOf(done.headers)

    const allowed: Record<string, string>[] = [
      { origin: other },
      { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      { origin: ORIGIN },
    ]
    for (const headers of allowed) {
      const reply = await refresh(cookie, headers)
      expect(reply.status).toBe(200)
      cookie = cookieOf(reply.headers)
    }
  })

  test('adds no CORS headers, and a preflight is not answered', async () => {
    const { app, done, refresh } = await setup()

    const reply = await refresh(cookieOf(done.headers))
    const preflight = await app.request('/v1/client/sessions/refresh', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    })

    for (const response of [reply.headers, preflight.headers]) {
      expect([...response.keys()].filter((key) => key.startsWith('access-control-'))).toEqual([])
    }
    expect(preflight.status).not.toBe(204)
  })
})

describe('every other client type is unchanged', () => {
  const clients: (string | undefined)[] = [undefined, 'web', 'ios', 'android', 'server']

  test.each(clients)(
    'client %p gets the token in the body and never a Set-Cookie',
    async (client) => {
      const deps = await createReadyDeps({ env: { SESSION_ALLOWED_ORIGINS: ORIGIN } })
      const app = createApp(deps)
      const email = 'maya@northline.app'
      const started = await call(app, 'POST', '/v1/client/sign-ups', {
        ...(client === undefined ? {} : { client }),
        body: { email, password: PASSWORD, organizationName: 'Northline' },
      })
      const done = await call(
        app,
        'POST',
        `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
        {
          ...(client === undefined ? {} : { client }),
          attempt: text(started.body, 'attemptSecret'),
          body: { code: emailedCode(deps, email) },
        }
      )
      const token = text(done.body, 'session.refreshToken')
      const refreshed = await call(app, 'POST', '/v1/client/sessions/refresh', {
        ...(client === undefined ? {} : { client }),
        // A cookie and a foreign Origin are not looked at: this client type reads the body.
        headers: { origin: 'https://evil.test', cookie: `${NAME}=nonsense` },
        body: { refreshToken: token },
      })
      const next = text(refreshed.body, 'refreshToken')
      const signedOut = await call(app, 'POST', '/v1/client/sessions/sign-out', {
        ...(client === undefined ? {} : { client }),
        headers: { origin: 'https://evil.test' },
        body: { refreshToken: next },
      })
      const noBody = await call(app, 'POST', '/v1/client/sessions/refresh', {
        ...(client === undefined ? {} : { client }),
        headers: { cookie: `${NAME}=${next}`, origin: ORIGIN },
      })

      expect(done.status).toBe(200)
      expect(refreshed.status).toBe(200)
      expect(signedOut.status).toBe(204)
      expect(noBody.status).toBe(400)
      for (const reply of [started, done, refreshed, signedOut, noBody]) {
        expect(reply.headers.getSetCookie()).toEqual([])
      }
      expect(Object.keys(done.body as Record<string, unknown>)).toEqual([
        'id',
        'kind',
        'expiresAt',
        'step',
        'session',
      ])
      expect(Object.keys((done.body as { session: object }).session)).toEqual([
        'sessionId',
        'accessToken',
        'accessTokenExpiresAt',
        'refreshToken',
        'organization',
      ])
      expect(Object.keys(refreshed.body as object)).toEqual([
        'sessionId',
        'accessToken',
        'accessTokenExpiresAt',
        'refreshToken',
        'organization',
      ])
    }
  )
})

describe('nothing sensitive reaches a log, an error or the reporter', () => {
  test('across every new path, no cookie value appears in logs, reports or error bodies', async () => {
    const { deps, done, refresh, signOut, browser } = await setup()
    const seen: string[] = [tokenOf(done.headers)]
    const bodies: unknown[] = []
    const first = await refresh(cookieOf(done.headers))
    seen.push(tokenOf(first.headers))
    deps.clock.advance('11s')
    // Reuse of the spent cookie, a foreign origin with a live cookie, an unknown cookie, a
    // malformed Cookie header, a sign-out, and a refresh after it.
    bodies.push(
      (await refresh(cookieOf(done.headers))).body,
      (await refresh(cookieOf(first.headers), { origin: 'https://evil.test' })).body,
      (await browser('/v1/client/sessions/refresh', { cookie: `${NAME}=${'x'.repeat(5_000)}` }))
        .body,
      (await browser('/v1/client/sessions/refresh', { cookie: `;;=${NAME}==; ${NAME}` })).body,
      (await signOut(cookieOf(first.headers))).body,
      (await refresh(cookieOf(first.headers))).body
    )

    const everything = `${deps.logLines.join('\n')}\n${JSON.stringify(bodies)}\n${JSON.stringify(
      deps.reported.map(({ error, context }) => ({
        message: error instanceof Error ? error.message : String(error),
        context,
      }))
    )}`
    for (const secret of seen) {
      expect(everything).not.toContain(secret)
    }
    expect(everything).not.toContain('Set-Cookie')
    expect(everything.toLowerCase()).not.toContain('cookie')
  })
})

const CLEAR = `${NAME}=; Path=${PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`

describe('a refresh that can never work again clears the cookie', () => {
  test('a terminal refusal clears the cookie with no-store, beyond the grace window', async () => {
    const { deps, done, refresh } = await setup()
    const old = cookieOf(done.headers)
    await refresh(old)
    deps.clock.advance('11s')

    const replay = await refresh(old)

    expect(at(replay.body, 'error.code')).toBe('session.reuse_detected')
    expect(replay.headers.getSetCookie()).toEqual([CLEAR])
    expect(replay.headers.get('cache-control')).toBe('no-store')
  })

  test('a revoked session, an unknown token, a banned user and an expired session clear it', async () => {
    const { deps, done, refresh, signOut } = await setup()
    const unknown = await refresh(`${NAME}=tula_rt_${'2'.repeat(64)}`)
    const garbage = await refresh(`${NAME}=nonsense`)
    const missing = await call(createApp(deps), 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { origin: ORIGIN },
    })
    const cookie = cookieOf(done.headers)
    await signOut(cookie)
    const revoked = await refresh(cookie)

    for (const [reply, code] of [
      [unknown, 'session.invalid_token'],
      [garbage, 'session.invalid_token'],
      [missing, 'session.invalid_token'],
      [revoked, 'session.revoked'],
    ] as const) {
      expect(at(reply.body, 'error.code')).toBe(code)
      expect(reply.headers.getSetCookie()).toEqual([CLEAR])
      expect(reply.headers.get('cache-control')).toBe('no-store')
    }
  })

  test('an expired session clears it', async () => {
    const { deps, done, refresh } = await setup()
    deps.clock.advance('31d')

    const reply = await refresh(cookieOf(done.headers))

    expect(at(reply.body, 'error.code')).toBe('session.expired')
    expect(reply.headers.getSetCookie()).toEqual([CLEAR])
  })

  test('a banned user clears it', async () => {
    const { deps, done, refresh } = await setup()
    const environmentId = deps.tenant.current?.environmentId ?? ''
    const user = await deps.users.findByEmail(environmentId, 'maya@northline.app')
    deps.users.ban(user?.id ?? '', deps.clock.now())

    const reply = await refresh(cookieOf(done.headers))

    expect(at(reply.body, 'error.code')).toBe('auth.user_banned')
    expect(reply.headers.getSetCookie()).toEqual([CLEAR])
  })

  test('a transient failure does not clear it, and the same cookie works after', async () => {
    const { deps, done, refresh } = await setup()
    const cookie = cookieOf(done.headers)
    deps.membership.breakDown(true)

    const down = await refresh(cookie)

    expect(down.status).toBe(503)
    expect(down.headers.getSetCookie()).toEqual([])
    deps.membership.breakDown(false)
    expect((await refresh(cookie)).status).toBe(200)
  })

  test('a refused Origin does not clear it: a foreign page cannot sign the user out', async () => {
    const { done, refresh } = await setup()
    const cookie = cookieOf(done.headers)

    const reply = await refresh(cookie, { origin: 'https://evil.test' })

    expect(reply.status).toBe(403)
    expect(reply.headers.getSetCookie()).toEqual([])
  })

  test('refresh after sign-out is 401 and clears', async () => {
    const { done, refresh, signOut } = await setup()
    const cookie = cookieOf(done.headers)
    await signOut(cookie)

    const reply = await refresh(cookie)

    expect(reply.status).toBe(401)
    expect(reply.headers.getSetCookie()).toEqual([CLEAR])
  })
})

describe('reading the Cookie header', () => {
  test('with the name twice, the first one wins', async () => {
    const { done, refresh } = await setup()
    const good = cookieOf(done.headers)
    const bad = `${NAME}=tula_rt_${'3'.repeat(64)}`

    expect((await refresh(`${good}; ${bad}`)).status).toBe(200)
    const next = await refresh(`${bad}; ${cookieOf(done.headers)}`)
    expect(next.status).toBe(401)
  })

  test('only the configured name is read', async () => {
    const { done, refresh } = await setup()
    const value = tokenOf(done.headers)

    for (const cookie of [
      `tula_refresh=${value}`,
      `x${NAME}=${value}`,
      `${NAME}x=${value}`,
      `${NAME.toLowerCase()}=${value}`,
    ]) {
      expect((await refresh(cookie)).status).toBe(401)
    }
    expect((await refresh(`tula_refresh=${value}; ${NAME}=${value}`)).status).toBe(200)
  })

  test('the unprefixed name is the one read when insecure, and not the prefixed one', async () => {
    const { done, refresh } = await setup({ env: { SESSION_COOKIE_INSECURE: 'true' } })
    const value = tokenOf(done.headers, 'tula_refresh')

    expect((await refresh(`${NAME}=${value}`)).status).toBe(401)
    expect((await refresh(`tula_refresh=${value}`)).status).toBe(200)
  })

  test('a quoted value is not a token', async () => {
    const { done, refresh } = await setup()

    const reply = await refresh(`${NAME}="${tokenOf(done.headers)}"`)

    expect(reply.status).toBe(401)
    expect(at(reply.body, 'error.code')).toBe('session.invalid_token')
  })

  test('a very long header is answered without error', async () => {
    const { refresh } = await setup()

    const reply = await refresh(`${NAME}=${'a'.repeat(200_000)}`)

    expect(reply.status).toBe(401)
    expect(at(reply.body, 'error.code')).toBe('session.invalid_token')
  })
})

describe('no-store on every response that sets or clears the cookie', () => {
  test('sign-up, sign-in, refresh, sign-out and the clears', async () => {
    const { done, signIn, refresh, signOut } = await setup()
    const replies = [
      done,
      await signIn(),
      await refresh(cookieOf(done.headers)),
      await refresh(`${NAME}=nonsense`),
      await signOut(cookieOf(done.headers)),
      await signOut(undefined),
    ]

    for (const reply of replies) {
      // One cookie, or two on a sign-in (the refresh cookie and the known-device cookie).
      expect(reply.headers.getSetCookie()).toHaveLength(reply === replies[1] ? 2 : 1)
      expect(reply.headers.get('cache-control')).toBe('no-store')
    }
  })
})

describe('two tabs refreshing together', () => {
  test('both succeed, the session lives, and the cookie the browser keeps still refreshes', async () => {
    const { done, refresh } = await setup()
    const cookie = cookieOf(done.headers)

    const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)])

    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(text(a.body, 'accessToken').length).toBeGreaterThan(20)
    expect(text(b.body, 'accessToken').length).toBeGreaterThan(20)
    expect(tokenOf(a.headers)).toBe(tokenOf(b.headers))
    expect((await refresh(cookieOf(b.headers))).status).toBe(200)
    expect((await refresh(cookieOf(a.headers))).status).toBe(200)
  })
})
