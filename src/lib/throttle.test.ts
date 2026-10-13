import { describe, expect, test } from 'bun:test'
import { createThrottle } from './throttle'

describe('createThrottle', () => {
  test('lets one through per key per window, and again after it', () => {
    let now = 1_000
    const throttle = createThrottle({ windowMs: 60_000, maxKeys: 8, now: () => now })

    expect(throttle.allow('a')).toBe(true)
    expect(throttle.allow('a')).toBe(false)
    expect(throttle.allow('b')).toBe(true)
    now += 59_999
    expect(throttle.allow('a')).toBe(false)
    now += 1
    expect(throttle.allow('a')).toBe(true)
  })

  test('remembers at most maxKeys keys, forgetting the least recently allowed', () => {
    const throttle = createThrottle({ windowMs: 60_000, maxKeys: 2, now: () => 5 })

    throttle.allow('a')
    throttle.allow('b')
    throttle.allow('c')

    expect(throttle.allow('b')).toBe(false)
    expect(throttle.allow('c')).toBe(false)
    expect(throttle.allow('a')).toBe(true)
  })

  test('a clock that moves backwards does not silence a key for ever', () => {
    let now = 100_000
    const throttle = createThrottle({ windowMs: 60_000, maxKeys: 2, now: () => now })

    throttle.allow('a')
    now = 10

    expect(throttle.allow('a')).toBe(true)
  })
})
