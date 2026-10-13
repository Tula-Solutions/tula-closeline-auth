import { expect, test } from 'bun:test'
import { withTimeout } from './timeout'

test('returns what the work returns when it is quicker than the deadline', async () => {
  expect(await withTimeout(Promise.resolve(7), 1_000, () => new Error('late'))).toBe(7)
})

test('passes the work’s own failure through', async () => {
  await expect(
    withTimeout(Promise.reject(new Error('boom')), 1_000, () => new Error('late'))
  ).rejects.toThrow('boom')
})

test('gives up with the supplied error when the work is slower than the deadline', async () => {
  const never = new Promise<number>(() => {})

  await expect(withTimeout(never, 5, () => new Error('late'))).rejects.toThrow('late')
})
