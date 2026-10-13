import { describe, expect, test } from 'bun:test'
import { MemoryBreachChecker } from '~/adapters/memory/breach-checker'
import { createTestDeps } from '~/testing'
import { evaluatePassword, PASSWORD_POLICY } from './rules'
import * as Passwords from './service'

const { limits } = createTestDeps()

describe('lanes', () => {
  test('work runs in the lane asked for, and a full lane is a 503 for that lane only', async () => {
    const lanes = createTestDeps({
      env: { HASH_CONCURRENCY: '1', HASH_QUEUE: '0', SIGN_IN_CONCURRENCY: '1', SIGN_IN_QUEUE: '0' },
    })
    let open: () => void = () => {}
    const held = Passwords.inLane(lanes, 'hash', () => new Promise<void>((r) => (open = r)))

    await expect(Passwords.inLane(lanes, 'hash', async () => 1)).rejects.toMatchObject({
      code: 'server.unavailable',
    })
    expect(await Passwords.inLane(lanes, 'signIn', async () => 2)).toBe(2)

    open()
    await held
  })

  test("a password beyond the cap is within no account's possible passwords", () => {
    expect(Passwords.withinLimit('x'.repeat(Passwords.MAX_PASSWORD_LENGTH))).toBe(true)
    expect(Passwords.withinLimit('x'.repeat(Passwords.MAX_PASSWORD_LENGTH + 1))).toBe(false)
  })
})

describe('hashing', () => {
  test('uses argon2id with the source parameters, and a hash verifies only its own password', async () => {
    const hash = await Passwords.hashHeld('correct horse battery')

    expect(hash).toStartWith('$argon2id$v=19$m=65536,t=2,p=1$')
    expect(Passwords.needsRehash(hash)).toBe(false)
    expect(await Passwords.verifyHeld(hash, 'correct horse battery')).toBe(true)
    expect(await Passwords.verifyHeld(hash, 'correct horse batterx')).toBe(false)
  })

  test('treats composed and decomposed forms of one passphrase as the same', async () => {
    const hash = await Passwords.hashHeld('café au lait 123')

    expect(await Passwords.verifyHeld(hash, 'café au lait 123')).toBe(true)
  })

  test('a hash made with other parameters is due for rehashing', () => {
    expect(Passwords.needsRehash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true)
  })

  test('with no stored hash it still answers false, and so does a password beyond the cap', async () => {
    expect(await Passwords.verifyHeld(null, 'anything at all')).toBe(false)
    expect(
      await Passwords.verifyHeld('$argon2id$x', 'x'.repeat(Passwords.MAX_PASSWORD_LENGTH * 16 + 1))
    ).toBe(false)
  })

  test('refuses to hash a password longer than the cap', async () => {
    await expect(
      Passwords.hashHeld('x'.repeat(Passwords.MAX_PASSWORD_LENGTH + 1))
    ).rejects.toMatchObject({
      code: 'password.too_long',
    })
  })
})

describe('the policy', () => {
  const info = { email: 'maya@northline.app', firstName: 'Maya' }

  test.each([
    ['short', 'password.too_short'],
    ['a'.repeat(129), 'password.too_long'],
    ['mayamaya-1234', 'password.contains_user_info'],
    ['1234567890', 'password.common'],
  ])('%s is refused with %s', async (password, code) => {
    const deps = { limits, breachChecker: new MemoryBreachChecker() }

    await expect(Passwords.assess(deps, password, info)).rejects.toMatchObject({ code })
  })

  test('lists every failed rule', async () => {
    const deps = { limits, breachChecker: new MemoryBreachChecker() }

    const error = await Passwords.assess(deps, 'maya', info).catch((e: unknown) => e)

    expect(error).toMatchObject({
      code: 'password.too_short',
      details: {
        min: 10,
        errors: [{ code: 'password.too_short' }, { code: 'password.contains_user_info' }],
      },
    })
  })

  test('refuses a breached password and accepts a clean one', async () => {
    const deps = {
      limits,
      breachChecker: new MemoryBreachChecker(['a clean-looking breached one']),
    }

    await expect(Passwords.assess(deps, 'a clean-looking breached one')).rejects.toMatchObject({
      code: 'password.breached',
    })
    await expect(Passwords.assess(deps, 'a perfectly fine passphrase')).resolves.toBeUndefined()
  })

  test('lets a password through when the breach lookup is unavailable (fail open)', async () => {
    const breachChecker = new MemoryBreachChecker()
    breachChecker.unavailable = true

    await expect(
      Passwords.assess({ limits, breachChecker }, 'a perfectly fine passphrase')
    ).resolves.toBeUndefined()
  })

  test('the rule engine measures code points, so emoji count as one character', () => {
    const { ok } = evaluatePassword(PASSWORD_POLICY, '😀😀😀😀😀😀😀😀😀😀')

    expect(ok).toBe(true)
  })
})
