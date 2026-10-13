import { expect, test } from 'bun:test'
import { createFixedClock } from 'tula-closeline-kit'
import { AGE_COUNTERS, followFixedClock } from './clock-aging'

test('a fixed clock that moved ages the counters once, before the next counter call', async () => {
  const clock = createFixedClock('2026-01-01T00:00:00Z')
  const ran: [string, number][] = []
  const settle = followFixedClock(clock, async (text, seconds) => void ran.push([text, seconds]))

  await settle()
  expect(ran).toEqual([])
  clock.advance('2m')
  clock.advance('30s')
  await settle()
  await settle()
  clock.advance('1s')
  await settle()

  expect(ran).toEqual([
    [AGE_COUNTERS, 150],
    [AGE_COUNTERS, 1],
  ])
})
