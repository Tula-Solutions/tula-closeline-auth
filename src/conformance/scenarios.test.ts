import { describe, expect, test } from 'bun:test'
import { createApp } from '~/app'
import { createReadyDeps } from '~/testing'
import { loadScenarios } from './load'
import { match } from './match'
import { runScenario, ScenarioFailure, scenarioSchema } from './runner'
import { fill } from './template'

const scenarios = await loadScenarios()

describe('conformance scenarios, in process over memory adapters', () => {
  test('there is a scenario for each in-scope flow', () => {
    expect(scenarios.map((s) => s.file.slice(0, 2)).sort()).toEqual(
      expect.arrayContaining(['01', '02', '03', '04', '05', '06', '08', '09', '13'])
    )
  })

  for (const { file, scenario } of scenarios) {
    test(`${file}: ${scenario.name}`, async () => {
      const deps = await createReadyDeps()

      await runScenario({ app: createApp(deps), deps }, scenario)
    })
  }
})

describe('the runner', () => {
  test('names the step and the field that differed, without quoting a token', async () => {
    const deps = await createReadyDeps()
    const scenario = scenarioSchema.parse({
      name: 'broken',
      description: 'expects the wrong thing',
      steps: [
        {
          name: 'the policy',
          request: { method: 'GET', path: '/v1/client/password-policy' },
          expect: { status: 200, body: { minLength: 11 } },
        },
      ],
    })

    const failure = await runScenario({ app: createApp(deps), deps }, scenario).catch(
      (e: unknown) => e
    )

    expect(failure).toBeInstanceOf(ScenarioFailure)
    expect((failure as Error).message).toContain('step "the policy"')
    expect((failure as Error).message).toContain('minLength')
  })

  test('fails a step whose capture finds nothing, and one that leaks an excluded value', async () => {
    const deps = await createReadyDeps()
    const world = { app: createApp(deps), deps }
    const base = {
      name: 'x',
      description: 'x',
    }

    await expect(
      runScenario(
        world,
        scenarioSchema.parse({
          ...base,
          steps: [
            {
              name: 'capture',
              request: { method: 'GET', path: '/v1/client/password-policy' },
              expect: { status: 200 },
              capture: { gone: 'nope' },
            },
          ],
        })
      )
    ).rejects.toThrow('nothing to capture')
    await expect(
      runScenario(
        world,
        scenarioSchema.parse({
          ...base,
          steps: [
            {
              name: 'leak',
              request: { method: 'GET', path: '/v1/client/password-policy' },
              expect: { status: 200, bodyExcludes: ['minLength'] },
            },
          ],
        })
      )
    ).rejects.toThrow('must not')
  })

  test('refuses a step kind it does not support', () => {
    expect(() =>
      scenarioSchema.parse({
        name: 'x',
        description: 'x',
        steps: [{ name: 'oauth', oauth: {} }],
      })
    ).toThrow()
  })

  test('matches the source’s matchers', () => {
    expect(
      match(
        { a: '$any', b: '$absent', c: { $not: 'x' }, d: { $matches: '^t' } },
        { a: 1, c: 'y', d: 'ta' }
      )
    ).toEqual([])
    expect(match({ a: '$any' }, {})).toHaveLength(1)
    expect(match({ $set: [1, 2] }, [2, 1])).toEqual([])
    expect(match([1, 2], [1])).toHaveLength(1)
    expect(fill({ a: ['{{x}}'] }, { x: 'v' })).toEqual({ a: ['v'] })
    expect(() => fill('{{missing}}', {})).toThrow('no value')
  })
})
