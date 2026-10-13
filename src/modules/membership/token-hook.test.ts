import { describe, expect, test } from 'bun:test'
import { decodeJwt } from 'jose'
import type { UserId } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { call, emailedCode, text } from '~/testing/client'
import { MEMBERSHIP_RETRY_AFTER_SECONDS } from './service'

/*
 * What the token hook does through auth's own routes: the Organization's status at sign-in and
 * refresh, and what each route does when core cannot answer. The adapter is the memory one.
 */

const PASSWORD = 'correct horse battery'
const EMAIL = 'maya@northline.app'

async function setup() {
  const deps = await createReadyDeps()
  const app = createApp(deps)
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'ios',
    body: { email: EMAIL, password: PASSWORD, organizationName: 'Northline' },
  })
  const verify = (code = emailedCode(deps, EMAIL)) =>
    call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
      attempt: text(started.body, 'attemptSecret'),
      body: { code },
    })
  const done = await verify()
  const refresh = (refreshToken: string) =>
    call(app, 'POST', '/v1/client/sessions/refresh', { body: { refreshToken } })
  const startSignIn = async () => {
    const attempt = await call(app, 'POST', '/v1/client/sign-ins', { body: { identifier: EMAIL } })
    return (password = PASSWORD) =>
      call(app, 'POST', `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`, {
        attempt: text(attempt.body, 'attemptSecret'),
        body: { password },
      })
  }
  const environmentId = deps.tenant.current?.environmentId ?? ''
  const userId = text(done.body, 'step.userId') as UserId
  const activeSessions = async () => {
    const user = await deps.users.findByEmail(environmentId, EMAIL)
    return (await deps.sessions.listActive(environmentId, user?.id ?? '', deps.clock.now(), 50))
      .length
  }
  return {
    deps,
    app,
    started,
    verify,
    done,
    refresh,
    startSignIn,
    activeSessions,
    userId,
    organizationId: text(done.body, 'session.organization.id'),
    refreshToken: text(done.body, 'session.refreshToken'),
    sessionId: text(done.body, 'session.sessionId'),
    environmentId,
  }
}

const unavailable = (reply: Awaited<ReturnType<typeof call>>) => {
  expect(reply.status).toBe(503)
  expect(reply.body).toMatchObject({ error: { code: 'membership.unavailable' } })
  expect(reply.headers.get('retry-after')).toBe(String(MEMBERSHIP_RETRY_AFTER_SECONDS))
  expect(JSON.stringify(reply.body)).not.toContain('Token')
}

describe('the Organization status at sign-in', () => {
  test.each(['active', 'suspended'] as const)(
    'an Organization that is %s issues tokens, with its id in them',
    async (status) => {
      const { deps, startSignIn, organizationId } = await setup()
      deps.membership.setOrganizationStatus(organizationId, status)
      const submit = await startSignIn()

      const reply = await submit()

      expect(reply.status).toBe(200)
      expect(decodeJwt(text(reply.body, 'session.accessToken')).org).toBe(organizationId)
    }
  )

  test('a deleted Organization refuses sign-in with organization.deleted, issues nothing and is not a fault', async () => {
    const { deps, startSignIn, organizationId, activeSessions } = await setup()
    deps.membership.setOrganizationStatus(organizationId, 'deleted')
    const before = await activeSessions()
    const submit = await startSignIn()

    const reply = await submit()

    expect(reply.status).toBe(410)
    expect(reply.body).toMatchObject({ error: { code: 'organization.deleted' } })
    expect(JSON.stringify(reply.body)).not.toContain('accessToken')
    expect(await activeSessions()).toBe(before)
    expect(deps.reported).toHaveLength(0)
  })

  test('a deleted Organization does not count against the lockout of the account', async () => {
    const { deps, startSignIn, organizationId } = await setup()
    deps.membership.setOrganizationStatus(organizationId, 'deleted')
    const submit = await startSignIn()

    for (let n = 0; n < 8; n++) {
      expect((await submit()).status).toBe(410)
    }
    deps.membership.setOrganizationStatus(organizationId, 'active')

    expect((await submit()).status).toBe(200)
  })

  test('an account with no membership at all is still auth.no_organization, reported', async () => {
    const { deps, startSignIn, userId } = await setup()
    deps.membership.forget(userId)
    const submit = await startSignIn()

    const reply = await submit()

    expect(reply.status).toBe(403)
    expect(reply.body).toMatchObject({ error: { code: 'auth.no_organization' } })
    expect(deps.reported).toHaveLength(1)
  })
})

describe('the Organization status at refresh', () => {
  test.each(['active', 'suspended'] as const)(
    'an Organization that is %s refreshes normally',
    async (status) => {
      const { deps, refresh, refreshToken, organizationId } = await setup()
      deps.membership.setOrganizationStatus(organizationId, status)

      const reply = await refresh(refreshToken)

      expect(reply.status).toBe(200)
      expect(decodeJwt(text(reply.body, 'accessToken')).org).toBe(organizationId)
    }
  )

  test('a deleted Organization ends the session: organization.deleted once, then the session is revoked', async () => {
    const { deps, app, refresh, refreshToken, organizationId, sessionId, environmentId, done } =
      await setup()
    const accessToken = text(done.body, 'session.accessToken')
    deps.membership.setOrganizationStatus(organizationId, 'deleted')

    const first = await refresh(refreshToken)
    const again = await refresh(refreshToken)
    const me = await call(app, 'GET', '/v1/client/me', { accessToken })

    expect(first.status).toBe(410)
    expect(first.body).toMatchObject({ error: { code: 'organization.deleted' } })
    expect(JSON.stringify(first.body)).not.toContain('accessToken')
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokeReason).toBe(
      'revoked_by_admin'
    )
    expect(again.status).toBe(401)
    expect(again.body).toMatchObject({ error: { code: 'session.revoked' } })
    expect(me.status).toBe(401)
    expect(deps.reported).toHaveLength(0)
  })

  test('a user who has other sessions keeps none of them either: each ends at its own next refresh', async () => {
    const { deps, startSignIn, refresh, organizationId } = await setup()
    const second = await (await startSignIn())()
    deps.membership.setOrganizationStatus(organizationId, 'deleted')

    const reply = await refresh(text(second.body, 'session.refreshToken'))

    expect(reply.status).toBe(410)
  })
})

describe('when core cannot answer', () => {
  test('sign-in is a 503 with Retry-After, issues nothing, and the same attempt works once core is back', async () => {
    const { deps, startSignIn, activeSessions } = await setup()
    const before = await activeSessions()
    const submit = await startSignIn()
    deps.membership.breakDown(true)

    const down = await submit()

    unavailable(down)
    expect(JSON.stringify(down.body)).not.toContain('accessToken')
    expect(await activeSessions()).toBe(before)
    deps.membership.breakDown(false)
    expect((await submit()).status).toBe(200)
    expect(await activeSessions()).toBe(before + 1)
  })

  test('it does not count against the lockout, however often the client tries', async () => {
    const { deps, startSignIn } = await setup()
    const submit = await startSignIn()
    deps.membership.breakDown(true)

    for (let n = 0; n < 12; n++) {
      expect((await submit()).status).toBe(503)
    }
    deps.membership.breakDown(false)

    expect((await submit()).status).toBe(200)
  })

  test('a wrong password is still counted and refused while core is down (it never reaches core)', async () => {
    const { deps, startSignIn } = await setup()
    const submit = await startSignIn()
    deps.membership.breakDown(true)
    const callsBefore = deps.membership.calls.lookup

    const wrong = await submit('not the password')

    expect(wrong.status).toBe(401)
    expect(deps.membership.calls.lookup).toBe(callsBefore)
  })

  test('refresh is a 503 with Retry-After and spends nothing: the same refresh token works afterwards', async () => {
    const { deps, refresh, refreshToken, sessionId, environmentId } = await setup()
    deps.membership.breakDown(true)

    for (let n = 0; n < 3; n++) {
      unavailable(await refresh(refreshToken))
    }
    deps.membership.breakDown(false)
    const up = await refresh(refreshToken)

    expect(up.status).toBe(200)
    expect(text(up.body, 'sessionId')).toBe(sessionId)
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokedAt).toBeNull()
    expect((await refresh(text(up.body, 'refreshToken'))).status).toBe(200)
  })

  test('refresh does not end the session when core is down, even for a replayed token in its grace period', async () => {
    const { deps, refresh, refreshToken, sessionId, environmentId } = await setup()
    const first = await refresh(refreshToken)
    deps.membership.breakDown(true)

    unavailable(await refresh(refreshToken))
    deps.membership.breakDown(false)
    const replay = await refresh(refreshToken)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect((await deps.sessions.findById(environmentId, sessionId))?.revokedAt).toBeNull()
  })

  test('sign-up is a 503 with Retry-After; the attempt and the code stay usable until core is back', async () => {
    const deps = await createReadyDeps()
    const app = createApp(deps)
    const started = await call(app, 'POST', '/v1/client/sign-ups', {
      client: 'ios',
      body: { email: EMAIL, password: PASSWORD, organizationName: 'Northline' },
    })
    const code = emailedCode(deps, EMAIL)
    const verify = () =>
      call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
        attempt: text(started.body, 'attemptSecret'),
        body: { code },
      })
    deps.membership.breakDown(true)

    unavailable(await verify())
    unavailable(await verify())
    deps.membership.breakDown(false)
    const done = await verify()

    expect(done.status).toBe(200)
    expect(deps.membership.organizations).toHaveLength(1)
  })

  test('sign-up with an invitation is the same', async () => {
    const deps = await createReadyDeps()
    const app = createApp(deps)
    deps.membership.invite('invite-token-0123456789abcdef', {
      email: EMAIL,
      organizationId: 'org_00000000000000000000000000000001',
      role: 'rep',
    })
    const started = await call(app, 'POST', '/v1/client/sign-ups', {
      client: 'ios',
      body: { email: EMAIL, password: PASSWORD, invitationToken: 'invite-token-0123456789abcdef' },
    })
    const code = emailedCode(deps, EMAIL)
    const verify = () =>
      call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
        attempt: text(started.body, 'attemptSecret'),
        body: { code },
      })
    deps.membership.breakDown(true)

    unavailable(await verify())
    deps.membership.breakDown(false)

    expect((await verify()).status).toBe(200)
  })

  test('core that never answers is a 503 too', async () => {
    const { deps, refresh, refreshToken } = await setup()
    const real = globalThis.setTimeout
    // Shrink the deadline for this test only; the production value is 5 seconds.
    globalThis.setTimeout = ((fn: () => void) => real(fn, 1)) as unknown as typeof setTimeout
    let reply: Awaited<ReturnType<typeof refresh>>
    try {
      deps.membership.forUser = () => new Promise<never>(() => {})
      reply = await refresh(refreshToken)
    } finally {
      globalThis.setTimeout = real
    }

    unavailable(reply)
  })
})
