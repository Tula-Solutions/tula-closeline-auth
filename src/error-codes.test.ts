import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import { AUTH_ERRORS, CORE_ERRORS, ERRORS, errorCodeSchema } from 'tula-closeline-contract'
import { fail, rateLimited } from '~/errors'

/**
 * Every `area.reason` code this service answers with is defined in `tula-closeline-contract`
 * (`AUTH_ERRORS`, or the common `ERRORS`). Two guards keep it so: `fail` accepts only those
 * definitions, which `tsc` enforces (the `@ts-expect-error` lines below fail the typecheck the
 * day that stops being true), and a scan of the shipped source, below, for any `area.reason`
 * string literal that is not a key of a contract map.
 */

const SOURCE = new URL('.', import.meta.url).pathname

/** Comments and string literals, in source order, so a literal inside a comment is skipped. */
const TOKENS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(["'`])((?:\\.|(?!\1)[^\\])*)\1/g

/** Source that ships: not a test and not an integration test. */
async function shippedFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const file of new Glob('**/*.ts').scan({ cwd: SOURCE, absolute: true })) {
    if (!file.endsWith('.test.ts') && !file.endsWith('.integration.ts')) {
      files.push(file)
    }
  }
  return files.sort()
}

/** Every `area.reason`-shaped string literal in a file's code (not its comments). */
function codeLiterals(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(TOKENS)) {
    const text = match[2]
    // The contract's own code pattern, so a code with a digit (`oauth2.denied`) is seen too.
    if (text !== undefined && errorCodeSchema.safeParse(text).success) {
      found.push(text)
    }
  }
  return found
}

/**
 * Codes that are not this service's to answer with but appear as data in shipped source. Core's
 * own refusals are read from its answers (the HTTP adapter) and written by its test double; they
 * are keys of the contract's `CORE_ERRORS`, and never sent to a client as they are.
 */
const CORE_CODE_FILES = ['adapters/http/membership.ts', 'testing/fake-core.ts']

/** A log fallback in place of a code that is not a safe identifier; never a response. */
const NOT_A_RESPONSE = new Set(['unsafe.code'])

test('no area.reason literal in shipped source is outside the contract', async () => {
  const answerable = new Set<string>([...Object.keys(ERRORS), ...Object.keys(AUTH_ERRORS)])
  const coreOnly = new Set<string>(Object.keys(CORE_ERRORS))
  const strays: string[] = []

  for (const file of await shippedFiles()) {
    const relative = file.slice(SOURCE.length)
    for (const code of codeLiterals(await Bun.file(file).text())) {
      const allowedCore = coreOnly.has(code) && CORE_CODE_FILES.includes(relative)
      if (!(answerable.has(code) || allowedCore || NOT_A_RESPONSE.has(code))) {
        strays.push(`${relative}: ${code}`)
      }
    }
  }

  expect(strays).toEqual([])
})

test('no service file defines errors of its own', async () => {
  const definers: string[] = []
  for (const file of await shippedFiles()) {
    if (/\bdefineErrors\b/.test(await Bun.file(file).text())) {
      definers.push(file.slice(SOURCE.length))
    }
  }

  expect(definers).toEqual([])
})

test('the scan sees a stray code, so it cannot pass by finding nothing', () => {
  const source = [
    "// 'team.in_a_comment' is skipped",
    "const a = 'auth.invalid_credentials'",
    'const b = `made.up_code`',
    "const url = 'https://example.com/a.b'",
    "const c = 'oauth2.denied'",
  ].join('\n')

  expect(codeLiterals(source)).toEqual([
    'auth.invalid_credentials',
    'made.up_code',
    'oauth2.denied',
  ])
})

test('fail takes the contract definitions of this service and nothing else', () => {
  expect(fail(AUTH_ERRORS['flow.not_found']).code).toBe('flow.not_found')
  expect(fail(ERRORS['rate.limited']).status).toBe(429)

  // The lines below do not compile; at run time they are refused too, as no entry is found.
  // @ts-expect-error a code of core's is not one auth answers with
  expect(() => fail(CORE_ERRORS['invitation.invalid'])).toThrow()
  // @ts-expect-error a definition written here is not in the contract
  expect(() => fail({ code: 'made.up_code', status: 400, message: 'No.' })).toThrow()
})

test('fail and rateLimited answer with the contract definition of the code, whatever status and message are passed', () => {
  const forged = { code: 'flow.not_found', status: 200, message: 'Nothing to see.' } as const

  expect(fail(forged)).toMatchObject({
    code: 'flow.not_found',
    status: AUTH_ERRORS['flow.not_found'].status,
    message: AUTH_ERRORS['flow.not_found'].message,
  })
  expect(rateLimited({ ...forged, code: 'rate.limited' }, 1000)).toMatchObject({
    status: ERRORS['rate.limited'].status,
    message: ERRORS['rate.limited'].message,
  })
})
