import { describe, expect, test } from 'bun:test'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '~/http/types'
import { DEVICE_COOKIE_NAME } from '~/modules/flow/device-cookie'
import type { TestDeps } from '~/testing'
import { at, call, emailedCode, text } from '~/testing/client'

/** What the scenarios run against: two API instances over one store, and the deps behind them. */
export type KnownDeviceHarness = {
  deps: TestDeps
  /** Two instances that share every counter, as two processes behind a balancer do. */
  apps: [OpenAPIHono<AppEnv>, OpenAPIHono<AppEnv>]
}

/** The contract error code of a response body, or `undefined`. */
function errorCode(body: unknown): unknown {
  return (body as { error?: { code?: unknown } } | null)?.error?.code
}

const PASSWORD = 'correct horse battery'
const WRONG = 'a stranger guessing'

/** The password tries that lock an address: 5 free, the 6th starts a wait, the 7th is refused. */
const TRIES_BEFORE_LOCK = 6

/**
 * The behaviour ADR 0014 asks of sign-in lockout, through the HTTP routes. Run against the memory
 * adapters (unit tests) and against Postgres with two instances (integration tests), so the two
 * cannot drift.
 *
 * @param name - What is under test, for the report.
 * @param setup - Builds a fresh harness; called once per scenario.
 */
export function describeKnownDevices(name: string, setup: () => Promise<KnownDeviceHarness>): void {
  describe(`${name}: lockout and known devices`, () => {
    let counter = 0

    async function scene() {
      const harness = await setup()
      const { deps, apps } = harness
      const [first, second] = apps
      const prefix = Bun.randomUUIDv7().slice(-12)

      /** A new account, signed in once from a browser so that device is known. */
      async function account(label: string) {
        const email = `${label}${++counter}.${prefix}@northline.app`
        const started = await call(first, 'POST', '/v1/client/sign-ups', {
          client: 'browser',
          body: { email, password: PASSWORD, organizationName: 'Northline' },
        })
        await call(first, 'POST', `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`, {
          client: 'browser',
          attempt: text(started.body, 'attemptSecret'),
          body: { code: emailedCode(deps, email) },
        })
        return email
      }

      /** One sign-in from a browser: start it, then submit the password (with a cookie, if any). */
      async function signIn(
        app: OpenAPIHono<AppEnv>,
        email: string,
        password: string,
        cookie?: string
      ) {
        const headers: Record<string, string> = cookie === undefined ? {} : { cookie }
        const started = await call(app, 'POST', '/v1/client/sign-ins', {
          client: 'browser',
          body: { identifier: email },
          headers,
        })
        return call(app, 'POST', `/v1/client/sign-ins/${text(started.body, 'id')}/password`, {
          client: 'browser',
          attempt: text(started.body, 'attemptSecret'),
          body: { password },
          headers,
        })
      }

      /** The device cookie (`name=value`) a response set. */
      function deviceCookie(reply: { headers: Headers }): string {
        const line = reply.headers
          .getSetCookie()
          .find((entry) => entry.startsWith(`${DEVICE_COOKIE_NAME}=`))
        if (line === undefined) {
          throw new Error('no known-device cookie was set')
        }
        return line.split(';')[0] ?? ''
      }

      /** An account whose browser has signed in once. */
      async function knownAccount(label = 'known') {
        const email = await account(label)
        const reply = await signIn(first, email, PASSWORD)
        expect(reply.status).toBe(200)
        return { email, cookie: deviceCookie(reply) }
      }

      /** Wrong passwords from devices with no cookie, alternating instances, until it is locked. */
      async function lock(email: string) {
        for (let n = 0; n < TRIES_BEFORE_LOCK; n++) {
          const reply = await signIn(n % 2 === 0 ? first : second, email, WRONG)
          expect(reply.status).toBe(401)
        }
      }

      return { deps, first, second, account, signIn, deviceCookie, knownAccount, lock }
    }

    test('six wrong passwords split across two instances lock the next, even for the right one', async () => {
      const { first, second, account, signIn } = await scene()
      const email = await account('split')

      for (let n = 0; n < TRIES_BEFORE_LOCK; n++) {
        expect((await signIn(n % 2 === 0 ? first : second, email, WRONG)).status).toBe(401)
      }
      const onFirst = await signIn(first, email, PASSWORD)
      const onSecond = await signIn(second, email, PASSWORD)

      for (const locked of [onFirst, onSecond]) {
        expect(locked.status).toBe(429)
        expect(locked.body).toMatchObject({ error: { code: 'rate.limited' } })
        expect(at(locked.body, 'error.details.retryAfter')).toBeNumber()
        expect(Number(locked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      }
    })

    test('a device with no cookie is refused with Retry-After while the address is locked', async () => {
      const { second, account, signIn, lock } = await scene()
      const email = await account('stranger')
      await lock(email)

      const reply = await signIn(second, email, PASSWORD)

      expect(reply.status).toBe(429)
      expect(reply.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/)
      expect(at(reply.body, 'session')).toBeUndefined()
    })

    test('a known device signs in while the address is locked, on either instance', async () => {
      const { first, second, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      await lock(email)

      const onFirst = await signIn(first, email, PASSWORD, cookie)
      const onSecond = await signIn(second, email, PASSWORD, cookie)

      expect(onFirst.status).toBe(200)
      expect(onSecond.status).toBe(200)
      expect(text(onFirst.body, 'session.accessToken').length).toBeGreaterThan(20)
    })

    test('a known device with the wrong password is a plain 401 while the address is locked', async () => {
      const { first, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      await lock(email)

      const reply = await signIn(first, email, WRONG, cookie)

      expect(reply.status).toBe(401)
      expect(reply.body).toMatchObject({ error: { code: 'auth.invalid_credentials' } })
    })

    test('a device that signs in again keeps its device id and renews the cookie', async () => {
      const { first, knownAccount, signIn, deviceCookie } = await scene()
      const { email, cookie } = await knownAccount()

      const again = await signIn(first, email, PASSWORD, cookie)

      expect(again.status).toBe(200)
      const idOf = (value: string) => value.split('=')[1]?.split('.')[2]
      expect(idOf(deviceCookie(again))).toBe(idOf(cookie))
    })

    test('a new device that signs in gets a cookie of its own', async () => {
      const { first, knownAccount, signIn, deviceCookie } = await scene()
      const { email, cookie } = await knownAccount()

      const other = await signIn(first, email, PASSWORD)

      const idOf = (value: string) => value.split('=')[1]?.split('.')[2]
      expect(idOf(deviceCookie(other))).not.toBe(idOf(cookie))
    })

    test.each([
      [
        'tampered',
        (cookie: string) => `${cookie.slice(0, -2)}${cookie.endsWith('AA') ? 'BB' : 'AA'}`,
      ],
      ['malformed', () => `${DEVICE_COOKIE_NAME}=not-a-cookie`],
      ['empty', () => `${DEVICE_COOKIE_NAME}=`],
      ['cut short', (cookie: string) => cookie.split('.').slice(0, 3).join('.')],
      ['of another name', (cookie: string) => cookie.replace(DEVICE_COOKIE_NAME, 'other')],
    ])(
      'a %s cookie is treated as no cookie: the locked address refuses it',
      async (_name, change) => {
        const { second, knownAccount, signIn, lock } = await scene()
        const { email, cookie } = await knownAccount()
        await lock(email)
        const none = await signIn(second, email, PASSWORD)

        const reply = await signIn(second, email, PASSWORD, change(cookie))

        expect(reply.status).toBe(none.status)
        expect(reply.status).toBe(429)
        expect(errorCode(reply.body)).toBe(errorCode(none.body))
        expect(at(reply.body, 'session')).toBeUndefined()
      }
    )

    test('a cookie for another account is treated as no cookie', async () => {
      const { second, knownAccount, signIn, lock } = await scene()
      const victim = await knownAccount('victim')
      const attacker = await knownAccount('attacker')
      await lock(victim.email)

      // The attacker's own cookie is genuinely signed, but for another account.
      const reply = await signIn(second, victim.email, PASSWORD, attacker.cookie)

      expect(reply.status).toBe(429)
      expect(errorCode(reply.body)).toBe('rate.limited')
    })

    test('a cookie whose account was rewritten to the victim fails its signature', async () => {
      const { second, knownAccount, signIn, lock, deps } = await scene()
      const victim = await knownAccount('victim')
      const attacker = await knownAccount('attacker')
      await lock(victim.email)
      const environmentId = deps.tenant.current?.environmentId ?? ''
      const victimUser = await deps.users.findByEmail(environmentId, victim.email)
      const [name, value] = attacker.cookie.split('=') as [string, string]
      const fields = value.split('.')
      fields[1] = victimUser?.id ?? ''
      const forged = `${name}=${fields.join('.')}`

      const reply = await signIn(second, victim.email, PASSWORD, forged)

      expect(reply.status).toBe(429)
    })

    test('an expired cookie is treated as no cookie', async () => {
      const { deps, second, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      deps.clock.advance('90d')
      deps.clock.advance('1s')
      await lock(email)

      const reply = await signIn(second, email, PASSWORD, cookie)

      expect(reply.status).toBe(429)
    })

    test('a cookie one second before its expiry still works', async () => {
      const { deps, second, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      deps.clock.advance('89d')
      deps.clock.advance('23h')
      deps.clock.advance('59m')
      deps.clock.advance('59s')
      await lock(email)

      const reply = await signIn(second, email, PASSWORD, cookie)

      expect(reply.status).toBe(200)
    })

    test('a known device is still bounded: its own wrong passwords lock that device', async () => {
      const { first, second, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      await lock(email)

      for (let n = 0; n < TRIES_BEFORE_LOCK; n++) {
        const reply = await signIn(n % 2 === 0 ? first : second, email, WRONG, cookie)
        expect(reply.status).toBe(401)
      }
      const locked = await signIn(first, email, PASSWORD, cookie)

      expect(locked.status).toBe(429)
      expect(locked.body).toMatchObject({ error: { code: 'rate.limited' } })
      expect(Number(locked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    })

    test('a known device locked on its own counter is locked on an unlocked address too', async () => {
      const { first, knownAccount, signIn } = await scene()
      const { email, cookie } = await knownAccount()
      // The address counter is cleared by no success here, so this exercises the device bound.
      for (let n = 0; n < TRIES_BEFORE_LOCK; n++) {
        expect((await signIn(first, email, WRONG, cookie)).status).toBe(401)
      }

      expect((await signIn(first, email, PASSWORD, cookie)).status).toBe(429)
    })

    test('a right password from a known device clears its own counter', async () => {
      const { first, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      await lock(email)

      // Four wrong then right, twice: six counted tries would lock the device without a clear.
      for (let round = 0; round < 2; round++) {
        for (let n = 0; n < 4; n++) {
          expect((await signIn(first, email, WRONG, cookie)).status).toBe(401)
        }
        expect((await signIn(first, email, PASSWORD, cookie)).status).toBe(200)
      }
    })

    test('a known device succeeding does not end the lock other people earned on the address', async () => {
      const { second, knownAccount, signIn, lock } = await scene()
      const { email, cookie } = await knownAccount()
      await lock(email)
      expect((await signIn(second, email, PASSWORD, cookie)).status).toBe(200)

      const stranger = await signIn(second, email, PASSWORD)

      expect(stranger.status).toBe(429)
    })

    test('a right password with no lock clears the address, so mistypes never add up', async () => {
      const { first, second, account, signIn } = await scene()
      const email = await account('mistypes')

      for (let round = 0; round < 4; round++) {
        for (let n = 0; n < 3; n++) {
          expect((await signIn(round % 2 === 0 ? first : second, email, WRONG)).status).toBe(401)
        }
        expect((await signIn(round % 2 === 0 ? second : first, email, PASSWORD)).status).toBe(200)
      }
    })

    test('a locked address and an unknown address refuse a stranger alike', async () => {
      const { second, account, signIn, lock } = await scene()
      const email = await account('locked')
      await lock(email)
      const ghost = `ghost.${Bun.randomUUIDv7().slice(-12)}@northline.app`
      for (let n = 0; n < TRIES_BEFORE_LOCK; n++) {
        await signIn(second, ghost, WRONG)
      }

      const real = await signIn(second, email, PASSWORD)
      const unknown = await signIn(second, ghost, PASSWORD)

      expect(real.status).toBe(unknown.status)
      expect(errorCode(real.body)).toBe(errorCode(unknown.body))
    })

    test('a valid cookie used against an address that has no account gives the stranger answer', async () => {
      const { second, knownAccount, signIn } = await scene()
      const { cookie } = await knownAccount()
      const ghost = `ghost.${Bun.randomUUIDv7().slice(-12)}@northline.app`
      for (let n = 0; n < TRIES_BEFORE_LOCK; n++) {
        await signIn(second, ghost, WRONG)
      }

      const reply = await signIn(second, ghost, PASSWORD, cookie)

      expect(reply.status).toBe(429)
    })
  })
}
