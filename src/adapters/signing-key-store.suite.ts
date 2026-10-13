import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type NewSigningKey,
  RETIRED_KEY_RETENTION_MS,
  type SigningKeyStore,
} from '~/ports/signing-key-store'

/** What a behaviour suite needs from an adapter under test. */
export type SigningKeyHarness = {
  store: SigningKeyStore
  /** Two environments of the same project, to prove one cannot see the other's keys. */
  environments: [
    { projectId: string; environmentId: string },
    { projectId: string; environmentId: string },
  ]
}

const T0 = new Date('2026-01-01T00:00:00Z')

function keyOf(
  harness: SigningKeyHarness,
  n: number,
  status: NewSigningKey['status'],
  at = T0,
  environment = 0
): NewSigningKey {
  const target = harness.environments[environment]
  if (!target) {
    throw new Error('no such environment')
  }
  const id = `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`
  return {
    id,
    projectId: target.projectId,
    environmentId: target.environmentId,
    status,
    publicJwk: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: `x${n}`.padEnd(43, 'A'),
      kid: id,
      alg: 'EdDSA',
      use: 'sig',
    },
    privateKeyCiphertext: `v1.sealed.${n}`,
    createdAt: at,
    activatedAt: status === 'active' ? at : null,
  }
}

/** The behaviour every SigningKeyStore adapter has, memory included. */
export function signingKeyStoreSuite(name: string, make: () => Promise<SigningKeyHarness>): void {
  describe(`${name} signing key store`, () => {
    let h: SigningKeyHarness
    beforeEach(async () => {
      h = await make()
    })
    const env = () => h.environments[0].environmentId

    test('the active key is read on its own: one record, or none', async () => {
      expect(await h.store.active(env())).toBeNull()
      await h.store.insert(env(), [
        keyOf(h, 1, 'active'),
        keyOf(h, 2, 'next'),
        keyOf(h, 3, 'retired', new Date(T0.getTime() - 1)),
      ])

      const active = await h.store.active(env())

      expect(active?.id).toBe(keyOf(h, 1, 'active').id)
      expect(active?.privateKeyCiphertext).toBe('v1.sealed.1')
      expect(await h.store.active(h.environments[1].environmentId)).toBeNull()
    })

    test('a retired key past its retention is left out by the store, not by the caller', async () => {
      const keys = [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')]
      await h.store.insert(env(), keys)
      let at = T0
      // 30 rotations: 30 retired keys, only the last few inside the retention window.
      for (let n = 0; n < 30; n++) {
        at = new Date(at.getTime() + 60_000 * 20)
        const current = await h.store.active(env())
        const upcoming = (await h.store.list(env())).find((key) => key.status === 'next')
        await h.store.rotate(
          env(),
          {
            retireId: current?.id ?? '',
            activateId: upcoming?.id ?? '',
            next: keyOf(h, 10 + n, 'next', at),
          },
          at
        )
      }

      const published = await h.store.verificationKeys(env(), at, 20)

      // next, active, and the two retired within the last 30 minutes (now and 20 minutes ago).
      expect(published).toHaveLength(4)
    })

    test('a second writer cannot take the active or next slot, and nothing of its batch lands', async () => {
      expect(await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')])).toBe(true)

      expect(await h.store.insert(env(), [keyOf(h, 3, 'next'), keyOf(h, 4, 'retired')])).toBe(false)

      expect((await h.store.list(env())).map((key) => key.id).sort()).toEqual([
        keyOf(h, 1, 'active').id,
        keyOf(h, 2, 'next').id,
      ])
    })

    test('a batch with two active keys is refused whole', async () => {
      expect(await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'active')])).toBe(
        false
      )
      expect(await h.store.list(env())).toEqual([])
    })

    test('one environment never sees the keys of another', async () => {
      await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')])
      const other = h.environments[1].environmentId

      expect(await h.store.list(other)).toEqual([])
      expect(await h.store.verificationKeys(other, T0, 20)).toEqual([])
      expect(
        await h.store.rotate(
          other,
          {
            retireId: keyOf(h, 1, 'active').id,
            activateId: keyOf(h, 2, 'next').id,
            next: keyOf(h, 9, 'next', T0, 1),
          },
          T0
        )
      ).toBe(false)
    })

    test('verification keys are the public keys of next, active and recently retired keys', async () => {
      await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')])
      await h.store.rotate(
        env(),
        {
          retireId: keyOf(h, 1, 'active').id,
          activateId: keyOf(h, 2, 'next').id,
          next: keyOf(h, 3, 'next', new Date(T0.getTime() + 1000)),
        },
        new Date(T0.getTime() + 1000)
      )

      const keys = await h.store.verificationKeys(env(), new Date(T0.getTime() + 2000), 20)

      expect(keys.map((key) => key.kid).sort()).toEqual([
        keyOf(h, 1, 'active').id,
        keyOf(h, 2, 'next').id,
        keyOf(h, 3, 'next').id,
      ])
      expect(JSON.stringify(keys)).not.toContain('sealed')
      expect(keys.every((key) => !('d' in key))).toBe(true)
    })

    test('a retired key stops being published after the retention window', async () => {
      await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')])
      const retiredAt = new Date(T0.getTime() + 1000)
      await h.store.rotate(
        env(),
        {
          retireId: keyOf(h, 1, 'active').id,
          activateId: keyOf(h, 2, 'next').id,
          next: keyOf(h, 3, 'next', retiredAt),
        },
        retiredAt
      )

      const justBefore = new Date(retiredAt.getTime() + RETIRED_KEY_RETENTION_MS - 1)
      const justAfter = new Date(retiredAt.getTime() + RETIRED_KEY_RETENTION_MS)

      expect(
        (await h.store.verificationKeys(env(), justBefore, 20)).map((key) => key.kid)
      ).toContain(keyOf(h, 1, 'active').id)
      expect(
        (await h.store.verificationKeys(env(), justAfter, 20)).map((key) => key.kid)
      ).not.toContain(keyOf(h, 1, 'active').id)
    })

    test('the number of published keys is capped, newest first', async () => {
      await h.store.insert(env(), [
        keyOf(h, 1, 'active'),
        keyOf(h, 2, 'next'),
        keyOf(h, 3, 'retired', new Date(T0.getTime() - 1)),
      ])

      const keys = await h.store.verificationKeys(env(), new Date(T0.getTime() + 1), 2)

      expect(keys).toHaveLength(2)
    })

    test('a rotation whose keys are not in the expected states changes nothing', async () => {
      await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')])
      const plan = {
        retireId: keyOf(h, 2, 'next').id,
        activateId: keyOf(h, 1, 'active').id,
        next: keyOf(h, 3, 'next'),
      }

      expect(await h.store.rotate(env(), plan, T0)).toBe(false)

      const statuses = (await h.store.list(env())).map((key) => [key.id, key.status]).sort()
      expect(statuses).toEqual([
        [keyOf(h, 1, 'active').id, 'active'],
        [keyOf(h, 2, 'next').id, 'next'],
      ])
    })

    test('of two rotations at once exactly one wins', async () => {
      await h.store.insert(env(), [keyOf(h, 1, 'active'), keyOf(h, 2, 'next')])
      const plan = (n: number) => ({
        retireId: keyOf(h, 1, 'active').id,
        activateId: keyOf(h, 2, 'next').id,
        next: keyOf(h, n, 'next'),
      })

      const results = await Promise.all([
        h.store.rotate(env(), plan(3), T0),
        h.store.rotate(env(), plan(4), T0),
      ])

      expect(results.filter(Boolean)).toHaveLength(1)
      const statuses = (await h.store.list(env())).map((key) => key.status).sort()
      expect(statuses).toEqual(['active', 'next', 'retired'])
    })
  })
}
