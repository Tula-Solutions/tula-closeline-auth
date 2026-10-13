import type { OpenAPIHono } from '@hono/zod-openapi'
import type { OrganizationId, Role, UserId } from 'tula-closeline-contract'
import { z } from 'zod'
import type { AppEnv } from '~/http/types'
import { randomToken } from '~/lib/crypto'
import { durationToMs } from '~/lib/duration'
import type { TestDeps } from '~/testing'
import { match, pick } from './match'
import { fill } from './template'

const requestSchema = z.strictObject({
  method: z.enum(['GET', 'POST']),
  path: z.string().startsWith('/'),
  accessToken: z.string().optional(),
  client: z.enum(['web', 'ios', 'android', 'server']).optional(),
  attempt: z.string().optional(),
  body: z.unknown().optional(),
})

const requestStep = z.strictObject({
  name: z.string().min(1),
  request: requestSchema,
  expect: z.strictObject({
    status: z.number().int(),
    body: z.unknown().optional(),
    bodyExcludes: z.array(z.string().min(1)).optional(),
  }),
  times: z.number().int().min(1).max(100).optional(),
  capture: z.record(z.string(), z.string()).optional(),
})

const emailCodeStep = z.strictObject({
  name: z.string().min(1),
  emailCode: z.strictObject({
    to: z.string(),
    capture: z.string(),
    captureWrong: z.string().optional(),
  }),
})

const waitStep = z.strictObject({ name: z.string().min(1), wait: z.string() })

/** Sets up the outside world, which a black-box scenario cannot reach: the core service. */
const arrangeStep = z.strictObject({
  name: z.string().min(1),
  arrange: z.strictObject({
    invite: z
      .strictObject({
        token: z.string(),
        email: z.string(),
        organizationId: z.string(),
        role: z.enum(['owner', 'admin', 'manager', 'rep']),
      })
      .optional(),
    membershipDown: z.boolean().optional(),
    forgetMembership: z.string().optional(),
  }),
})

/** A scenario file: variables, then steps run in order. */
export const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  variables: z
    .record(
      z.string(),
      z.union([z.string(), z.strictObject({ generate: z.enum(['email', 'password']) })])
    )
    .default({}),
  steps: z.array(z.union([requestStep, emailCodeStep, waitStep, arrangeStep])).min(1),
})

/** A parsed scenario. */
export type Scenario = z.infer<typeof scenarioSchema>

/** What a scenario runs against: the app, and the doubles it arranges and reads. */
export type World = {
  app: OpenAPIHono<AppEnv>
  deps: Pick<TestDeps, 'mailer' | 'clock' | 'membership'>
}

/** Thrown when a step does not behave as the scenario says; the message never holds a secret. */
export class ScenarioFailure extends Error {
  constructor(scenario: string, step: string, problems: string[]) {
    super(`${scenario}: step "${step}" failed:\n  ${problems.join('\n  ')}`)
    this.name = 'ScenarioFailure'
  }
}

function initial(scenario: Scenario): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [name, value] of Object.entries(scenario.variables)) {
    if (typeof value === 'string') {
      variables[name] = value
    } else if (value.generate === 'email') {
      variables[name] = `conf-${randomToken(16)
        .toLowerCase()
        .replaceAll(/[^a-z0-9]/g, 'x')}@example.com`
    } else {
      variables[name] = `pw-${randomToken(24)}`
    }
  }
  return variables
}

/** The six-digit code in the latest email to `to`, and a different six-digit code. */
function emailedCodes(world: World, to: string): { right: string; wrong: string } {
  const message = [...world.deps.mailer.outbox]
    .reverse()
    .find((mail) => mail.to.toLowerCase() === to.toLowerCase())
  const right = message ? /\b(\d{6})\b/.exec(message.text)?.[1] : undefined
  if (!right) {
    throw new Error(`no code was emailed to ${to}`)
  }
  return { right, wrong: right === '000000' ? '111111' : '000000' }
}

async function send(world: World, request: z.infer<typeof requestSchema>) {
  const headers: Record<string, string> = {}
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (request.attempt !== undefined) {
    headers['x-tula-attempt'] = request.attempt
  }
  if (request.accessToken !== undefined) {
    headers.authorization = `Bearer ${request.accessToken}`
  }
  if (request.client !== undefined) {
    headers['x-tula-client'] = request.client
  }
  const response = await world.app.request(request.path, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  })
  const raw = await response.text()
  return {
    status: response.status,
    raw,
    body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
  }
}

/**
 * Runs a scenario, step by step, against a running app.
 *
 * Variables captured from a response are available to later steps as `{{name}}`. A failure names
 * the step and the fields that differed; long strings, tokens and keys are never quoted.
 *
 * @throws ScenarioFailure at the first step that does not behave as written.
 */
export async function runScenario(world: World, scenario: Scenario): Promise<void> {
  const variables = initial(scenario)
  for (const step of scenario.steps) {
    if ('wait' in step) {
      world.deps.clock.advance(`${durationToMs(step.wait)}ms`)
    } else if ('emailCode' in step) {
      const { right, wrong } = emailedCodes(world, fill(step.emailCode.to, variables))
      variables[step.emailCode.capture] = right
      if (step.emailCode.captureWrong) {
        variables[step.emailCode.captureWrong] = wrong
      }
    } else if ('arrange' in step) {
      const { invite, membershipDown, forgetMembership } = fill(step.arrange, variables)
      if (invite) {
        world.deps.membership.invite(invite.token, {
          email: invite.email,
          organizationId: invite.organizationId as OrganizationId,
          role: invite.role as Role,
        })
      }
      if (membershipDown !== undefined) {
        world.deps.membership.breakDown(membershipDown)
      }
      if (forgetMembership) {
        world.deps.membership.forget(forgetMembership as UserId)
      }
    } else {
      for (let time = 0; time < (step.times ?? 1); time++) {
        const sent = await send(world, fill(step.request, variables))
        const expected = fill(step.expect, variables)
        const problems: string[] = []
        if (sent.status !== expected.status) {
          problems.push(`expected status ${expected.status}, got ${sent.status}`)
        }
        if (expected.body !== undefined) {
          problems.push(...match(expected.body, sent.body).map((m) => m.message))
        }
        for (const text of expected.bodyExcludes ?? []) {
          if (sent.raw.includes(text)) {
            problems.push('the body holds a value it must not')
          }
        }
        if (problems.length > 0) {
          throw new ScenarioFailure(scenario.name, step.name, problems)
        }
        for (const [name, path] of Object.entries(step.capture ?? {})) {
          const value = pick(sent.body, path)
          if (typeof value !== 'string') {
            throw new ScenarioFailure(scenario.name, step.name, [`nothing to capture at ${path}`])
          }
          variables[name] = value
        }
      }
    }
  }
}
