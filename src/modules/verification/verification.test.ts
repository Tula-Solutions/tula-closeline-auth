import { expect, test } from 'bun:test'
import { AUTH_ERRORS } from 'tula-closeline-contract'
import * as Verification from '~/modules/verification/service'
import { createReadyDeps } from '~/testing'
import { emailedCode } from '~/testing/client'

test('a code used up between the two reads answers expired, not too_many_attempts', async () => {
  const deps = await createReadyDeps()
  const tenant = deps.tenant.current
  if (!tenant) {
    throw new Error('no tenant')
  }
  const subject = { flowAttemptId: 'attempt-1' }
  await Verification.issue(deps, tenant, { flowAttemptId: 'attempt-1', destination: 'a@b.test' })
  const code = emailedCode(deps, 'a@b.test')
  const real = deps.verificationTokens
  // Another request spends the code after this one read it and before this one counts a try.
  const racing = {
    findLatest: real.findLatest.bind(real),
    recordAttempt: async (environmentId: string, id: string, now: Date) => {
      await real.consume(environmentId, id, now)
      return real.recordAttempt(environmentId, id, now)
    },
  } as unknown as typeof real

  const verify = Verification.verifyCode(
    { ...deps, verificationTokens: racing },
    tenant,
    subject,
    code
  )

  await expect(verify).rejects.toMatchObject({ code: AUTH_ERRORS['verification.expired'].code })
})
