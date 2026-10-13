import { describe, expect, test } from 'bun:test'
import { MemoryBreachChecker } from '~/adapters/memory/breach-checker'
import { createTestDeps } from '~/testing'
import { evaluatePassword, PASSWORD_POLICY } from './rules'
import * as Passwords from './service'

const { limits } = createTestDeps()
const deps = { limits }

describe('hashing', () => {
  test('uses argon2id with the source parameters, and a hash verifies only its own password', async () => {
    const hash = await Passwords.hash(deps, 'correct horse battery')

    expect(hash).toStartWith('$argon2id$v=19$m=65536,t=2,p=1$')
    expect(Passwords.needsRehash(hash)).toBe(false)
    expect(await Passwords.verify(deps, hash, 'correct horse battery')).toBe(true)
    expect(await Passwords.verify(deps, hash, 'correct horse batterx')).toBe(false)
  })

  test('treats composed and decomposed forms of one passphrase as the same', async () => {
    const hash = await Passwords.hash(deps, 'café au lait 123')

    expect(await Passwords.verify(deps, hash, 'café au lait 123')).toBe(true)
  })

  test('a hash made with other parameters is due for rehashing', () => {
    expect(Passwords.needsRehash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true)
  })

  test('with no stored hash it still answers false, and so does a password beyond the cap', async () => {
    expect(await Passwords.verify(deps, null, 'anything at all')).toBe(false)
    expect(
      await Passwords.verify(
        deps,
        '$argon2id$x',
        'x'.repeat(Passwords.MAX_PASSWORD_LENGTH * 16 + 1)
      )
    ).toBe(false)
  })

  test('refuses to hash a password longer than the cap', async () => {
    await expect(
      Passwords.hash(deps, 'x'.repeat(Passwords.MAX_PASSWORD_LENGTH + 1))
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
