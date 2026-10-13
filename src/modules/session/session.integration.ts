import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import { at, call, emailedCode, text } from '~/testing/client'
import { createPostgresDeps } from '~/testing/postgres-deps'
import { REUSE_GRACE_MS } from './service'

let deps: Awaited<ReturnType<typeof createPostgresDeps>>

beforeAll(async () => {
  deps = await createPostgresDeps()
})
afterAll(() => deps.stop())

async function signedUp(email: string) {
  const app = createApp(deps)
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    body: { email, password: 'correct horse battery', organizationName: 'Northline' },
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
  return { app, done, refresh, refreshToken: text(done.body, 'session.refreshToken') }
}

describe('sessions against a real Postgres', () => {
  test('refreshing the same token many times at once rotates it once and hands everyone the same next token', async () => {
    const { refresh, refreshToken } = await signedUp('rotate@northline.app')

    const replies = await Promise.all(Array.from({ length: 8 }, () => refresh(refreshToken)))

    expect(replies.map((r) => r.status)).toEqual(Array(8).fill(200))
    expect(new Set(replies.map((r) => text(r.body, 'refreshToken'))).size).toBe(1)
  })

  test('replaying a spent token after the grace period ends the session for good', async () => {
    const { app, done, refresh, refreshToken } = await signedUp('reuse@northline.app')
    const next = await refresh(refreshToken)
    deps.clock.advance(`${Math.ceil(REUSE_GRACE_MS / 1000) + 1}s`)

    const replay = await refresh(refreshToken)
    const newest = await refresh(text(next.body, 'refreshToken'))
    const me = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(done.body, 'session.accessToken'),
    })

    expect(at(replay.body, 'error.code')).toBe('session.reuse_detected')
    expect(at(newest.body, 'error.code')).toBe('session.reuse_detected')
    expect(at(me.body, 'error.code')).toBe('session.revoked')
  })

  test('signing out ends the session for refresh and for its live access token', async () => {
    const { app, done, refresh, refreshToken } = await signedUp('out@northline.app')

    const out = await call(app, 'POST', '/v1/client/sessions/sign-out', { body: { refreshToken } })

    expect(out.status).toBe(204)
    expect(at((await refresh(refreshToken)).body, 'error.code')).toBe('session.revoked')
    const me = await call(app, 'GET', '/v1/client/me', {
      accessToken: text(done.body, 'session.accessToken'),
    })
    expect(at(me.body, 'error.code')).toBe('session.revoked')
  })
})
