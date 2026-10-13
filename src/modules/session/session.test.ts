import { describe, expect, test } from 'bun:test'
import type { OrganizationId, UserId } from 'tula-closeline-contract'
import { createStaticKeySet, createTokenVerifier } from 'tula-closeline-kit'
import { createApp } from '~/app'
import { publicUrl } from '~/env'
import { jwksSchema } from '~/modules/jwks/schema'
import * as Jwks from '~/modules/jwks/service'
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

  test('does not list ended sessions, and ignores a cursor that was tampered with', async () => {
    const { deps, app, signIn, refreshToken } = await setup()
    deps.clock.advance('1s')
    const second = await signIn()
    await call(app, 'POST', '/v1/client/sessions/sign-out', { body: { refreshToken } })

    const page = await call(app, 'GET', '/v1/client/sessions?cursor=%25%25%25', {
      accessToken: text(second.body, 'session.accessToken'),
    })

    expect(page.status).toBe(200)
    expect(at(page.body, 'items')).toHaveLength(1)
  })
})
