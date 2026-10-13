import { describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { call, emailedCode, text } from '~/testing/client'
import {
  DEVICE_COOKIE_NAME,
  DEVICE_COOKIE_NAME_INSECURE,
  DEVICE_COOKIE_TTL_MS,
} from './device-cookie'
import { describeKnownDevices } from './known-device.suite'

// The memory adapters: both instances are the one container, as a store shared by two would be.
describeKnownDevices('memory adapters', async () => {
  const deps = await createReadyDeps()
  const app = createApp(deps)
  return { deps, apps: [app, app] }
})

const PASSWORD = 'correct horse battery'

async function signedIn(env: Record<string, string> = {}, client = 'browser') {
  const deps = await createReadyDeps({ env })
  const app = createApp(deps)
  const email = 'maya@northline.app'
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client,
    body: { email, password: PASSWORD, organizationName: 'Northline' },
  })
  await call(app, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
    client,
    attempt: text(started.body, 'attemptSecret'),
    body: { code: emailedCode(deps, email) },
  })
  const attempt = await call(app, 'POST', '/v1/client/sign-ins', {
    client,
    body: { identifier: email },
  })
  const reply = await call(
    app,
    'POST',
    `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`,
    {
      client,
      attempt: text(attempt.body, 'attemptSecret'),
      body: { password: PASSWORD },
    }
  )
  return { deps, app, email, reply }
}

describe('the known-device cookie', () => {
  test('is HttpOnly, Secure, SameSite=Strict, host-only, on the sign-in path, and expires in 90 days', async () => {
    const { reply } = await signedIn()

    const line = reply.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${DEVICE_COOKIE_NAME}=`))

    expect(line).toBeDefined()
    const attributes = (line ?? '').split('; ').slice(1)
    expect(attributes).toEqual([
      'Path=/v1/client/sign-ins',
      `Max-Age=${DEVICE_COOKIE_TTL_MS / 1000}`,
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
    ])
    expect(line).not.toContain('Domain')
    expect(DEVICE_COOKIE_TTL_MS).toBe(90 * 24 * 3_600_000)
  })

  test('is a different cookie from the refresh cookie, and neither is in the body', async () => {
    const { reply } = await signedIn()

    const names = reply.headers.getSetCookie().map((entry) => entry.split('=')[0])

    expect(names).toEqual(['__Secure-tula_refresh', DEVICE_COOKIE_NAME])
    expect(JSON.stringify(reply.body)).not.toContain('known_device')
    expect(JSON.stringify(reply.body)).not.toContain('deviceCookie')
  })

  test('carries no address, and signs the account and an expiry into its value', async () => {
    const { reply, email, deps } = await signedIn()

    const value = (reply.headers.getSetCookie().find((e) => e.startsWith(DEVICE_COOKIE_NAME)) ?? '')
      .split(';')[0]
      ?.split('=')[1]
    const [version, userId, deviceId, expires, signature] = (value ?? '').split('.')

    expect(value).not.toContain(email)
    expect(version).toBe('v1')
    const user = await deps.users.findByEmail(deps.tenant.current?.environmentId ?? '', email)
    expect(userId).toBe(user?.id)
    expect(deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Number(expires) * 1000).toBe(deps.clock.now().getTime() + DEVICE_COOKIE_TTL_MS)
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('with SESSION_COOKIE_INSECURE (local only) has no prefix and no Secure, like the refresh cookie', async () => {
    const { reply } = await signedIn({ SESSION_COOKIE_INSECURE: 'true' })

    const line = reply.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${DEVICE_COOKIE_NAME_INSECURE}=`))

    expect(line).toBeDefined()
    expect(line).toContain('HttpOnly')
    expect(line).toContain('SameSite=Strict')
    expect(line).not.toContain('Secure')
  })

  test.each(['ios', 'android', 'web', 'server'])('is not set for a %s client', async (client) => {
    const { reply } = await signedIn({}, client)

    expect(reply.status).toBe(200)
    expect(reply.headers.getSetCookie()).toEqual([])
  })

  test('is not set when the sign-in fails', async () => {
    const deps = await createReadyDeps()
    const app = createApp(deps)
    const attempt = await call(app, 'POST', '/v1/client/sign-ins', {
      client: 'browser',
      body: { identifier: 'nobody@northline.app' },
    })

    const reply = await call(
      app,
      'POST',
      `/v1/client/sign-ins/${text(attempt.body, 'id')}/password`,
      {
        client: 'browser',
        attempt: text(attempt.body, 'attemptSecret'),
        body: { password: PASSWORD },
      }
    )

    expect(reply.status).toBe(401)
    expect(reply.headers.getSetCookie()).toEqual([])
  })

  test('another key signs a different value, so a cookie from one key is refused by another', async () => {
    const one = await signedIn({ DEVICE_COOKIE_KEY: 'k'.repeat(40) })
    const two = await signedIn({ DEVICE_COOKIE_KEY: 'j'.repeat(40) })

    const signatureOf = (headers: Headers) =>
      (headers.getSetCookie().find((e) => e.startsWith(DEVICE_COOKIE_NAME)) ?? '')
        .split(';')[0]
        ?.split('.')
        .at(-1)

    expect(signatureOf(one.reply.headers)).not.toBe(signatureOf(two.reply.headers))
  })
})

describe('what the lockout writes to the log and the response', () => {
  test('no address, cookie value, key or password appears in a log line or a refusal body', async () => {
    const { deps, app, email, reply } = await signedIn()
    const cookie = (
      reply.headers.getSetCookie().find((e) => e.startsWith(DEVICE_COOKIE_NAME)) ?? ''
    ).split(';')[0] as string
    const value = cookie.split('=')[1] as string
    const bodies: unknown[] = []
    for (let n = 0; n < 8; n++) {
      const started = await call(app, 'POST', '/v1/client/sign-ins', {
        client: 'browser',
        body: { identifier: email },
        headers: { cookie },
      })
      bodies.push(
        (
          await call(app, 'POST', `/v1/client/sign-ins/${text(started.body, 'id')}/password`, {
            client: 'browser',
            attempt: text(started.body, 'attemptSecret'),
            body: { password: 'a stranger guessing' },
          })
        ).body
      )
    }

    const everything = JSON.stringify(bodies) + deps.logLines.join('\n')

    expect(everything).not.toContain(email)
    expect(everything).not.toContain(value)
    expect(everything).not.toContain('a stranger guessing')
    expect(everything).not.toContain(deps.env.COUNTER_HASH_KEY ?? 'unset')
    expect(everything).not.toContain(deps.env.DEVICE_COOKIE_KEY ?? 'unset')
  })
})
