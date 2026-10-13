import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import type { OrganizationId, UserId } from 'tula-closeline-contract'
import { createStaticKeySet, createTokenVerifier } from 'tula-closeline-kit'
import { createApp } from '~/app'
import { publicUrl } from '~/env'
import { sha256Hex } from '~/lib/crypto'
import * as Bootstrap from '~/modules/bootstrap/service'
import { jwksSchema } from '~/modules/jwks/schema'
import * as Jwks from '~/modules/jwks/service'
import * as Tokens from '~/modules/token/service'
import { createReadyDeps } from '~/testing'
import { at, call, emailedCode, text } from '~/testing/client'
import { REUSE_GRACE_MS } from './service'

const PASSWORD = 'correct horse battery'

async function setup() {
  const deps = await createReadyDeps()
  const app = createApp(deps)
  const email = 'maya@northline.app'
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'ios',
    body: { email, password: PASSWORD, organizationName: 'Northline' },
  })
  const done = await call(
    app,
    'POST',
    `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
    {
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    }
  )
  const refresh = (refreshToken: string) =>
    call(app, 'POST', '/v1/client/sessions/refresh', { body: { refreshToken } })
  const signIn = async () => {
    const attempt = await call(app, 'POST', '/v1/client/sign-ins', { body: { identifier: email } })
    return call(app, 'POST', `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`, {
      attempt: text(attempt.body, 'attemptSecret'),
      body: { password: PASSWORD },
    })
  }
  return {
    deps,
    app,
    done,
    refresh,
    signIn,
    refreshToken: text(done.body, 'session.refreshToken'),
    accessToken: text(done.body, 'session.accessToken'),
    sessionId: text(done.body, 'session.sessionId'),
  }
}

describe('refreshing', () => {
  test('returns new tokens for the same session, and each refresh token works once', async () => {
    const { refresh, refreshToken, sessionId } = await setup()

    const second = await refresh(refreshToken)

    expect(second.status).toBe(200)
    expect(text(second.body, 'sessionId')).toBe(sessionId)
    expect(text(second.body, 'refreshToken')).not.toBe(refreshToken)
    expect(text(second.body, 'refreshToken')).toStartWith('tula_rt_')
    const third = await refresh(text(second.body, 'refreshToken'))
    expect(third.status).toBe(200)
    expect(text(third.body, 'refreshToken')).not.toBe(text(second.body, 'refreshToken'))
  })

  test('the access token it returns is verified by the kit and names the Organization', async () => {
    const { deps, app, refresh, refreshToken, done } = await setup()
    deps.clock.advance('30s')

    const next = await refresh(refreshToken)

    const keys = jwksSchema.parse(await (await app.request('/.well-known/jwks.json')).json())
    const verified = await createTokenVerifier({
      issuer: publicUrl(deps.env),
      audience: deps.env.TOKEN_AUDIENCE,
      keys: await createStaticKeySet(keys),
      clock: deps.clock,
    }).verify(text(next.body, 'accessToken'))
    expect(verified.organizationId).toBe(
      text(done.body, 'session.organization.id') as OrganizationId
    )
    expect(verified.userId).toBe(text(done.body, 'step.userId') as UserId)
    expect(verified.expiresAt.getTime()).toBeGreaterThan(deps.clock.now().getTime())
  })

  test('the same token again within the grace period returns the same next token', async () => {
    const { deps, refresh, refreshToken } = await setup()
    const first = await refresh(refreshToken)
    deps.clock.advance('2s')

    const retry = await refresh(refreshToken)

    expect(retry.status).toBe(200)
    expect(text(retry.body, 'refreshToken')).toBe(text(first.body, 'refreshToken'))
    expect(text(retry.body, 'accessToken')).not.toBe('')
  })

  test('a spent token after the grace period ends the whole session, newest token included', async () => {
    const { deps, app, refresh, refreshToken, accessToken } = await setup()
    const second = await refresh(refreshToken)
    const third = await refresh(text(second.body, 'refreshToken'))
    deps.clock.advance(`${Math.ceil(REUSE_GRACE_MS / 1000) + 1}s`)

    const replay = await refresh(refreshToken)
    const newest = await refresh(text(third.body, 'refreshToken'))
    const live = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(third.body, 'accessToken'),
    })
    const original = await call(app, 'GET', '/v1/client/me', { accessToken })

    expect(replay.status).toBe(401)
    expect(at(replay.body, 'error.code')).toBe('session.reuse_detected')
    expect(newest.body).toMatchObject({ error: { code: 'session.reuse_detected' } })
    expect(live.body).toMatchObject({ error: { code: 'session.revoked' } })
    expect(original.status).toBe(401)
    expect(deps.logLines.some((line) => line.includes('reuse detected'))).toBe(true)
  })

  test.each([
    ['unknown', `tula_rt_${'0'.repeat(43)}`],
    ['wrong prefix', 'something-else'],
    ['too long', `tula_rt_${'a'.repeat(300)}`],
  ])('a %s token is session.invalid_token', async (_name, token) => {
    const { refresh } = await setup()

    const reply = await refresh(token)

    expect(reply.status).toBe(401)
    expect(reply.body).toMatchObject({ error: { code: 'session.invalid_token' } })
  })

  test('a session idle for a week has expired', async () => {
    const { deps, refresh, refreshToken } = await setup()
    deps.clock.advance('8d')

    const reply = await refresh(refreshToken)

    expect(reply.body).toMatchObject({ error: { code: 'session.expired' } })
  })

  test('a session cannot be extended past 30 days by refreshing', async () => {
    const { deps, refresh, refreshToken } = await setup()
    let token = refreshToken
    for (let day = 0; day < 4; day++) {
      deps.clock.advance('6d')
      const next = await refresh(token)
      expect(next.status).toBe(200)
      token = text(next.body, 'refreshToken')
    }
    deps.clock.advance('7d')

    const reply = await refresh(token)

    expect(reply.body).toMatchObject({ error: { code: 'session.expired' } })
  })

  test('a banned user is signed out and refused', async () => {
    const { deps, refresh, refreshToken, sessionId, done } = await setup()
    const environmentId = deps.tenant.current?.environmentId ?? ''
    const user = await deps.users.findByEmail(environmentId, 'maya@northline.app')
    deps.users.ban(user?.id ?? '', deps.clock.now())

    const reply = await refresh(refreshToken)

    expect(done.status).toBe(200)
    expect(reply.status).toBe(403)
    expect(reply.body).toMatchObject({ error: { code: 'auth.user_banned' } })
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokeReason).toBe(
      'user_banned'
    )
  })

  test('reads the Organization again: a user who lost theirs gets no new token and is reported', async () => {
    const { deps, refresh, refreshToken, done } = await setup()
    deps.membership.forget(text(done.body, 'step.userId') as UserId)

    const reply = await refresh(refreshToken)

    expect(reply.status).toBe(403)
    expect(reply.body).toMatchObject({ error: { code: 'auth.no_organization' } })
    expect(deps.reported).toHaveLength(1)
  })

  test('with the membership service down, nothing is rotated and a retry works', async () => {
    const { deps, refresh, refreshToken } = await setup()
    deps.membership.breakDown(true)

    const down = await refresh(refreshToken)
    deps.membership.breakDown(false)
    const up = await refresh(refreshToken)

    expect(down.status).toBe(503)
    expect(up.status).toBe(200)
  })

  test('a lost rotation race asks core once for the request, and the loser gets the same next token', async () => {
    const { deps, refresh, refreshToken } = await setup()
    const lookups = deps.membership.calls.lookup
    const real = deps.membership.forUser
    let asking = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // Both requests have read the token and are waiting on core before either rotates it.
    deps.membership.forUser = async (userId, signal) => {
      asking += 1
      if (asking === 2) {
        release()
      }
      await gate
      return real(userId, signal)
    }

    const [one, two] = await Promise.all([refresh(refreshToken), refresh(refreshToken)])

    expect([one.status, two.status]).toEqual([200, 200])
    expect(text(one.body, 'refreshToken')).toBe(text(two.body, 'refreshToken'))
    expect(deps.membership.calls.lookup - lookups).toBe(2)
  })

  test('a token spent beyond the grace period is reuse at once: no call to core, and an outage does not defer it', async () => {
    const { deps, refresh, refreshToken, sessionId } = await setup()
    await refresh(refreshToken)
    deps.clock.advance(`${Math.ceil(REUSE_GRACE_MS / 1000) + 1}s`)
    deps.membership.breakDown(true)
    const lookups = deps.membership.calls.lookup

    const replay = await refresh(refreshToken)

    expect(replay.status).toBe(401)
    expect(replay.body).toMatchObject({ error: { code: 'session.reuse_detected' } })
    expect(deps.membership.calls.lookup).toBe(lookups)
    const environmentId = deps.tenant.current?.environmentId ?? ''
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokeReason).toBe(
      'reuse_detected'
    )
  })

  test('an ended or expired session costs no call to core', async () => {
    const { deps, refresh, refreshToken } = await setup()
    deps.clock.advance('8d')
    const lookups = deps.membership.calls.lookup

    const reply = await refresh(refreshToken)

    expect(reply.body).toMatchObject({ error: { code: 'session.expired' } })
    expect(deps.membership.calls.lookup).toBe(lookups)
  })

  test('the clock is read again after core answers: the token and the rotation carry that time', async () => {
    const { deps, refresh, refreshToken } = await setup()
    const real = deps.membership.forUser
    deps.membership.forUser = async (userId, signal) => {
      deps.clock.advance('4s')
      return real(userId, signal)
    }

    const reply = await refresh(refreshToken)

    const after = deps.clock.now()
    expect(reply.status).toBe(200)
    expect(decodeJwt(text(reply.body, 'accessToken')).iat).toBe(Math.floor(after.getTime() / 1000))
    const environmentId = deps.tenant.current?.environmentId ?? ''
    const spent = await deps.sessions.findToken(environmentId, sha256Hex(refreshToken))
    expect(spent?.token.usedAt?.getTime()).toBe(after.getTime())
  })

  test('a session revoked while core is being asked is refused on a replay inside the grace window', async () => {
    const { deps, refresh, refreshToken, sessionId } = await setup()
    await refresh(refreshToken)
    deps.clock.advance('2s')
    const environmentId = deps.tenant.current?.environmentId ?? ''
    const real = deps.membership.forUser
    deps.membership.forUser = async (userId, signal) => {
      await deps.sessions.revoke(environmentId, sessionId, 'sign_out', deps.clock.now())
      return real(userId, signal)
    }

    const replay = await refresh(refreshToken)

    expect(replay.status).toBe(401)
    expect(replay.body).toMatchObject({ error: { code: 'session.revoked' } })
    expect(JSON.stringify(replay.body)).not.toContain('tula_rt_')
    expect(JSON.stringify(replay.body)).not.toContain('accessToken')
  })

  test('a user banned while core is being asked is refused on a replay inside the grace window', async () => {
    const { deps, refresh, refreshToken, sessionId } = await setup()
    await refresh(refreshToken)
    deps.clock.advance('2s')
    const environmentId = deps.tenant.current?.environmentId ?? ''
    const user = await deps.users.findByEmail(environmentId, 'maya@northline.app')
    const real = deps.membership.forUser
    deps.membership.forUser = async (userId, signal) => {
      deps.users.ban(user?.id ?? '', deps.clock.now())
      return real(userId, signal)
    }

    const replay = await refresh(refreshToken)

    expect(replay.status).toBe(403)
    expect(replay.body).toMatchObject({ error: { code: 'auth.user_banned' } })
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokeReason).toBe(
      'user_banned'
    )
  })

  test('a next token spent while core is being asked makes the replay reuse', async () => {
    const { deps, refresh, refreshToken, sessionId } = await setup()
    const first = await refresh(refreshToken)
    deps.clock.advance('2s')
    const real = deps.membership.forUser
    deps.membership.forUser = async (userId, signal) => {
      deps.membership.forUser = real
      await refresh(text(first.body, 'refreshToken'))
      return real(userId, signal)
    }

    const replay = await refresh(refreshToken)

    expect(replay.body).toMatchObject({ error: { code: 'session.reuse_detected' } })
    const environmentId = deps.tenant.current?.environmentId ?? ''
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokeReason).toBe(
      'reuse_detected'
    )
  })

  describe('an expiry that passes while core is being asked', () => {
    const FAR = new Date('2100-01-01T00:00:00Z')
    type Limits = { idle: Date; absolute: Date; token: Date }

    /** Core takes 4 s, and the stored rows say when each limit falls (a second or two in). */
    async function withLimits(limits: (soon: Date) => Limits) {
      const ctx = await setup()
      const { deps } = ctx
      const environmentId = deps.tenant.current?.environmentId ?? ''
      const read = deps.sessions.findToken.bind(deps.sessions)
      const set = limits(new Date(deps.clock.now().getTime() + 2000))
      deps.sessions.findToken = async (...args) => {
        const found = await read(...args)
        return (
          found && {
            token: { ...found.token, expiresAt: set.token },
            session: {
              ...found.session,
              idleExpiresAt: set.idle,
              absoluteExpiresAt: set.absolute,
            },
          }
        )
      }
      const forUser = deps.membership.forUser
      deps.membership.forUser = async (userId, signal) => {
        deps.clock.advance('4s')
        return forUser(userId, signal)
      }
      return { ...ctx, environmentId, read }
    }

    test.each([
      ['idle', (soon: Date) => ({ idle: soon, absolute: FAR, token: FAR })],
      ['absolute', (soon: Date) => ({ idle: FAR, absolute: soon, token: FAR })],
      ['token', (soon: Date) => ({ idle: FAR, absolute: FAR, token: soon })],
    ])('the %s expiry refuses the refresh and rotates nothing', async (_name, limits) => {
      const { deps, refresh, refreshToken, read, environmentId } = await withLimits(limits)

      const reply = await refresh(refreshToken)

      expect(reply.status).toBe(401)
      expect(reply.body).toMatchObject({ error: { code: 'session.expired' } })
      expect((await read(environmentId, sha256Hex(refreshToken)))?.token.usedAt).toBeNull()
      expect(deps.membership.calls.lookup).toBeGreaterThan(0)
    })
  })

  test('a role change reaches the next token', async () => {
    const { deps, refresh, refreshToken, done } = await setup()
    const userId = text(done.body, 'step.userId') as UserId
    deps.membership.forget(userId)
    deps.membership.invite('promote', {
      email: 'maya@northline.app',
      organizationId: text(done.body, 'session.organization.id'),
      role: 'manager',
    })
    await deps.membership.acceptInvitation({
      userId,
      invitationToken: 'promote',
      email: 'maya@northline.app',
      idempotencyKey: 'promote-key',
    })

    const next = await refresh(refreshToken)

    expect(next.body).toMatchObject({ organization: { role: 'manager' } })
  })
})

describe('signing out', () => {
  test('ends the session at once: refresh and the unexpired access token are refused', async () => {
    const { app, refresh, refreshToken, accessToken } = await setup()

    const out = await call(app, 'POST', '/v1/client/sessions/sign-out', { body: { refreshToken } })
    const again = await refresh(refreshToken)
    const me = await call(app, 'GET', '/v1/client/me', { accessToken })

    expect(out.status).toBe(204)
    expect(again.body).toMatchObject({ error: { code: 'session.revoked' } })
    expect(me.status).toBe(401)
    expect(me.body).toMatchObject({ error: { code: 'session.revoked' } })
  })

  test('succeeds for an unknown or malformed token too, and says nothing about it', async () => {
    const { app } = await setup()

    for (const refreshToken of [`tula_rt_${'0'.repeat(43)}`, 'garbage']) {
      const reply = await call(app, 'POST', '/v1/client/sessions/sign-out', {
        body: { refreshToken },
      })
      expect(reply.status).toBe(204)
      expect(reply.body).toBeNull()
    }
  })
})

describe('authenticating a request', () => {
  test.each([
    ['no header', undefined, 'auth.unauthenticated'],
    ['not a bearer', 'Basic abc', 'auth.unauthenticated'],
    ['a token that is not a token', 'Bearer not-a-jwt', 'auth.token_invalid'],
  ])('%s is refused', async (_name, header, code) => {
    const { app } = await setup()

    const reply = await app.request(
      '/v1/client/me',
      header ? { headers: { authorization: header } } : {}
    )

    expect(reply.status).toBe(401)
    expect(((await reply.json()) as { error: { code: string } }).error.code).toBe(code)
  })

  test('an expired access token is auth.token_expired', async () => {
    const { deps, app, accessToken } = await setup()
    deps.clock.advance('5m')

    const reply = await call(app, 'GET', '/v1/client/me', { accessToken })

    expect(reply.body).toMatchObject({ error: { code: 'auth.token_expired' } })
  })

  test('a token signed before a key rotation still works after it', async () => {
    const { deps, app, signIn } = await setup()
    const tenant = deps.tenant.current
    if (!tenant) {
      throw new Error('no tenant')
    }
    deps.clock.advance('11m')
    const signed = await signIn()
    await Jwks.rotate(deps, tenant)

    const reply = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(signed.body, 'session.accessToken'),
    })

    expect(reply.status).toBe(200)
  })
})

describe('listing sessions', () => {
  test('lists the user’s sessions newest first, marking the one asking, a page at a time', async () => {
    const { deps, app, signIn, sessionId } = await setup()
    deps.clock.advance('1s')
    const second = await signIn()
    deps.clock.advance('1s')
    const third = await signIn()

    const page = await call(app, 'GET', '/v1/client/sessions?limit=2', {
      accessToken: text(second.body, 'session.accessToken'),
    })

    expect(page.status).toBe(200)
    expect(at(page.body, 'items')).toHaveLength(2)
    expect(page.body).toMatchObject({
      items: [
        { id: text(third.body, 'session.sessionId'), current: false },
        { id: text(second.body, 'session.sessionId'), current: true },
      ],
    })
    const cursor = text(page.body, 'nextCursor')
    const rest = await call(app, 'GET', `/v1/client/sessions?limit=2&cursor=${cursor}`, {
      accessToken: text(second.body, 'session.accessToken'),
    })
    expect(rest.body).toMatchObject({
      items: [{ id: sessionId, current: false }],
      nextCursor: null,
    })
  })

  test('does not list ended sessions', async () => {
    const { deps, app, signIn, refreshToken } = await setup()
    deps.clock.advance('1s')
    const second = await signIn()
    await call(app, 'POST', '/v1/client/sessions/sign-out', { body: { refreshToken } })

    const page = await call(app, 'GET', '/v1/client/sessions', {
      accessToken: text(second.body, 'session.accessToken'),
    })

    expect(page.status).toBe(200)
    expect(at(page.body, 'items')).toHaveLength(1)
  })
})

describe('a cursor the database cannot use', () => {
  const position = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

  test.each([
    ['a time outside the valid date range', { t: 1e20, i: '0190c0de-0000-7000-8000-000000000000' }],
    ['a negative time', { t: -1, i: '0190c0de-0000-7000-8000-000000000000' }],
    ['a fractional time', { t: 1.5, i: '0190c0de-0000-7000-8000-000000000000' }],
    ['an id that is not a uuid', { t: 1_700_000_000_000, i: 'x' }],
  ])('%s is a 400 and is not reported', async (_name, value) => {
    const { deps, app, accessToken } = await setup()

    const page = await call(app, 'GET', `/v1/client/sessions?cursor=${position(value)}`, {
      accessToken,
    })

    expect(page.status).toBe(400)
    expect(page.body).toMatchObject({ error: { code: 'request.invalid' } })
    expect(deps.reported).toHaveLength(0)
  })

  test('a cursor the service did not issue is refused rather than silently read as the first page', async () => {
    const { app, accessToken } = await setup()

    const page = await call(app, 'GET', '/v1/client/sessions?cursor=%25%25%25', { accessToken })

    expect(page.status).toBe(400)
  })
})

describe('a live access token does not outlast what it stands for', () => {
  test('a token whose session has timed out is refused as expired', async () => {
    const { deps, app, accessToken } = await setup()
    const findById = deps.sessions.findById.bind(deps.sessions)
    // The token is good for 60 seconds; the session behind it ran out of idle time just now.
    deps.sessions.findById = async (environmentId, id) => {
      const session = await findById(environmentId, id)
      return session && { ...session, idleExpiresAt: new Date(deps.clock.now().getTime() - 1) }
    }

    const me = await call(app, 'GET', '/v1/client/me', { accessToken })

    expect(me.status).toBe(401)
    expect(at(me.body, 'error.code')).toBe('session.expired')
  })

  test('a validly signed token for one user carrying the session of another is refused', async () => {
    const { deps, app } = await setup()
    const tenant = Bootstrap.requireTenant(deps)
    const other = await call(app, 'POST', '/v1/client/sign-ups', {
      body: {
        email: 'other@northline.app',
        password: PASSWORD,
        organizationName: 'Elsewhere',
      },
    })
    const otherDone = await call(
      app,
      'POST',
      `/v1/client/sign-ups/${text(other.body, 'id')}/verify-email`,
      {
        attempt: text(other.body, 'attemptSecret'),
        body: { code: emailedCode(deps, 'other@northline.app') },
      }
    )
    const first = await deps.users.findByEmail(tenant.environmentId, 'maya@northline.app')
    const second = await deps.users.findByEmail(tenant.environmentId, 'other@northline.app')
    const sign = await Tokens.signer(deps, tenant)

    // Signed by the real key, subject = the first user, session = the second user's.
    const forged = await sign(
      {
        id: text(otherDone.body, 'session.sessionId'),
        userId: first?.id ?? '',
        authenticatedAt: deps.clock.now(),
        authMethods: ['pwd'],
      },
      { organizationId: `org_${'a'.repeat(32)}` as OrganizationId, role: 'owner' },
      deps.clock.now()
    )
    const me = await call(app, 'GET', '/v1/client/me', { accessToken: forged.accessToken })

    expect(second?.id).not.toBe(first?.id)
    expect(me.status).toBe(401)
    expect(at(me.body, 'error.code')).toBe('auth.token_invalid')
  })
})
