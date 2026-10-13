import { describe, expect, test } from 'bun:test'
import { MAX_PERSON_NAME_LENGTH, personNameSchema } from 'tula-closeline-contract'
import { signUpRequestSchema } from '~/modules/flow/schema'
import { composeMemberName } from './profile'

const long = (n: number, char = 'a') => char.repeat(n)

describe('the name sent to core', () => {
  test.each([
    ['both', 'Maya', 'Rao', 'Maya Rao'],
    ['first only', 'Maya', undefined, 'Maya'],
    ['last only', undefined, 'Rao', 'Rao'],
    ['neither', undefined, undefined, null],
    ['both null', null, null, null],
    ['both empty', '', '', null],
    ['both blank', '   ', ' \t ', null],
    ['padded', '  Maya ', '\tRao  ', 'Maya Rao'],
    ['empty first', '', 'Rao', 'Rao'],
    ['null last', 'Maya', null, 'Maya'],
    ['interior space is kept', 'Mary Ann', 'Van Der Berg', 'Mary Ann Van Der Berg'],
    ['non-ASCII', 'Zoë', '李', 'Zoë 李'],
    ['a control character inside becomes a space', 'Ma\u0007ya', 'Rao', 'Ma ya Rao'],
    ['a newline inside becomes a space', 'Maya', 'R\nao', 'Maya R ao'],
    ['a C1 control inside becomes a space', 'Maya', 'R\u0085ao', 'Maya R ao'],
    ['only control characters in one part', '\u0007', 'Rao', 'Rao'],
    ['only control characters in both', '\u0007', '\u0001', null],
  ])('%s', (_label, first, last, expected) => {
    expect(composeMemberName(first, last)).toBe(expected)
  })

  test('two parts at auth limit of 100 characters are exactly the contract limit', () => {
    const name = composeMemberName(long(100), long(100, 'b'))
    expect(name).toBe(`${long(100)} ${long(100, 'b')}`)
    expect(name?.length).toBe(MAX_PERSON_NAME_LENGTH)
    expect(personNameSchema.safeParse(name).success).toBe(true)
  })

  test('the longest sign-up request auth accepts always composes to a name the contract accepts', () => {
    // Auth's own limit per part (100 characters, measured after trimming) is checked here against
    // the real request schema, with padding that the schema trims off.
    const request = signUpRequestSchema.safeParse({
      email: 'maya@northline.app',
      password: 'correct horse battery',
      firstName: `  ${long(100)}  `,
      lastName: `${long(100, 'b')}\n`,
      organizationName: 'Northline',
    })
    expect(request.success).toBe(true)
    if (request.success) {
      const name = composeMemberName(request.data.firstName, request.data.lastName)
      expect(personNameSchema.safeParse(name).success).toBe(true)
    }
  })

  test('a name every part of which auth accepts is never sent as something the contract refuses', () => {
    const awkward = ['\u0000x', 'a\u007fb', '\u009f', 'é'.repeat(100), '😀'.repeat(50), ' ', 'x​y']
    for (const first of awkward) {
      for (const last of awkward) {
        const name = composeMemberName(first, last)
        if (name !== null) {
          expect(personNameSchema.safeParse(name).success).toBe(true)
        }
      }
    }
  })
})
