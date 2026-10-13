import { ERRORS, formatId, type UserId } from 'tula-closeline-contract'
import { z } from 'zod'
import type { Container } from '~/container'
import { AUTH_ERRORS, fail, rateLimited } from '~/errors'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { durationToMs } from '~/lib/duration'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'
import * as Membership from '~/modules/membership/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Tokens from '~/modules/token/service'
import { accountExistsEmail } from '~/modules/verification/mail'
import * as Verification from '~/modules/verification/service'
import type { Tenant } from '~/ports/fixed-project'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { CREDENTIAL_LOCKOUT, signInLockKey } from '~/ports/lockout'
import type { Membership as MembershipClaim } from '~/ports/membership'
import type { SessionClient } from '~/ports/session-store'
import {
  ATTEMPT_SECRET_PREFIX,
  type FlowKind,
  type FlowStatus,
  type passwordRequestSchema,
  type signUpRequestSchema,
} from './schema'

/** How long an attempt can be completed. */
export const ATTEMPT_TTL = '10m'

/** Purpose string for sealing the invitation token kept on a pending sign-up. */
export const SEAL_PURPOSE = 'flow-state'

/** A hash no secret has, compared against when the attempt does not exist (constant time). */
const NO_SECRET_HASH = 'x'.repeat(64)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a pending attempt remembers, validated whenever it is read back. */
const stateSchema = z.object({
  client: z.enum(['web', 'ios', 'android', 'server']),
  email: z.string().optional(),
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  /** The argon2id hash of the password chosen at sign-up; never the password. */
  passwordHash: z.string().optional(),
  /** The address already has an account: the attempt looks real but can never complete. */
  decoy: z.boolean().optional(),
  /** The id the account will have, chosen up front so a retry is the same sign-up. */
  userId: z.string().optional(),
  organizationName: z.string().optional(),
  /** The invitation token, sealed with the master key. */
  sealedInvitation: z.string().optional(),
})
type State = z.infer<typeof stateSchema>

/** What the HTTP layer tells a flow about the request. */
export type ClientContext = {
  client: SessionClient
  /** Reports a failure that is the deployment's to fix (e.g. an account with no Organization). */
  report: (error: unknown, status: number) => void
}

/** Which attempt, and the secret the caller says it holds. */
export type AttemptRef = { id: string; secret: string | undefined }

/** The answer to a step: what the response schema describes. */
export type FlowResult = {
  id: string
  kind: FlowKind
  expiresAt: string
  step: {
    status: FlowStatus
    strategies?: ('email_code' | 'password')[]
    destination?: string
    userId?: string
    sessionId?: string
  }
  attemptSecret?: string
  session?: Sessions.IssuedSession
}

function stepFor(attempt: FlowAttemptRecord, state: State): FlowResult['step'] {
  if (attempt.status === 'needs_email_verification') {
    return {
      status: attempt.status,
      strategies: ['email_code'],
      destination: maskEmail(state.email ?? attempt.identifier),
    }
  }
  return { status: attempt.status }
}

function present(attempt: FlowAttemptRecord, state: State, secret?: string): FlowResult {
  return {
    id: attempt.id,
    kind: attempt.kind,
    expiresAt: attempt.expiresAt.toISOString(),
    step: stepFor(attempt, state),
    ...(secret === undefined ? {} : { attemptSecret: secret }),
  }
}

async function start(
  deps: Container,
  tenant: Tenant,
  input: Pick<FlowAttemptRecord, 'id' | 'kind' | 'status' | 'identifier'> & { state: State }
): Promise<{ attempt: FlowAttemptRecord; secret: string }> {
  const now = deps.clock.now()
  const secret = `${ATTEMPT_SECRET_PREFIX}${randomToken()}`
  const attempt: FlowAttemptRecord = {
    ...input,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    userId: null,
    secretHash: sha256Hex(secret),
    expiresAt: new Date(now.getTime() + durationToMs(ATTEMPT_TTL)),
    completedAt: null,
    createdAt: now,
  }
  await deps.flowAttempts.create(attempt)
  return { attempt, secret }
}

/**
 * Loads an open attempt of the given kind for the client that started it.
 *
 * Every step goes through here, so none can forget the secret check: an unknown, foreign,
 * wrong-kind, completed or expired attempt, and any attempt presented without its secret, with a
 * wrong one or with another attempt's, are all the same `flow.not_found`. An attempt id alone
 * reveals and does nothing. Hashes are compared in constant time, and a comparison is made even
 * when there is no attempt.
 */
async function load(
  deps: Container,
  tenant: Tenant,
  kind: FlowKind,
  ref: AttemptRef
): Promise<{ attempt: FlowAttemptRecord; state: State }> {
  const attempt = UUID.test(ref.id)
    ? await deps.flowAttempts.findById(tenant.environmentId, ref.id)
    : null
  const expected = attempt?.secretHash ?? null
  const presented = timingSafeEqual(sha256Hex(ref.secret ?? ''), expected ?? NO_SECRET_HASH)
  if (
    !attempt ||
    expected === null ||
    ref.secret === undefined ||
    !presented ||
    attempt.kind !== kind ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= deps.clock.now().getTime()
  ) {
    throw fail(AUTH_ERRORS['flow.not_found'])
  }
  return { attempt, state: stateSchema.parse(attempt.state) }
}

/** Starts a sign-up: checks the address and password, emails a code, creates nothing else. */
export async function signUp(
  deps: Container,
  tenant: Tenant,
  input: z.infer<typeof signUpRequestSchema>,
  context: ClientContext
): Promise<FlowResult> {
  const parsed = parseEmail(input.email)
  if (!parsed) {
    throw fail(AUTH_ERRORS['email.invalid'])
  }
  const { email, normalized: identifier } = parsed
  const firstName = input.firstName?.trim() || null
  const lastName = input.lastName?.trim() || null
  await Passwords.assess(deps, input.password, {
    email,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
  })
  const passwordHash = await Passwords.hash(input.password)

  // An address that already has an account gets an attempt that looks the same and can never
  // complete, and the account's owner gets a notice instead of a code: starting a sign-up must
  // not reveal whether an address is registered.
  const decoy = (await deps.users.findByEmail(tenant.environmentId, identifier)) !== null
  const id = deps.ids.next()
  const state: State = decoy
    ? { client: context.client, email, decoy: true }
    : {
        client: context.client,
        email,
        firstName,
        lastName,
        passwordHash,
        userId: deps.ids.next(),
        ...(input.organizationName === undefined
          ? {
              sealedInvitation: await deps.secretBox.seal(
                SEAL_PURPOSE,
                new TextEncoder().encode(input.invitationToken ?? ''),
                id
              ),
            }
          : { organizationName: input.organizationName }),
      }
  const { attempt, secret } = await start(deps, tenant, {
    id,
    kind: 'sign_up',
    status: 'needs_email_verification',
    identifier,
    state,
  })
  try {
    await Verification.issue(deps, tenant, {
      flowAttemptId: attempt.id,
      destination: email,
      ...(decoy ? { message: (_code, _ttl, to) => accountExistsEmail(to) } : {}),
    })
  } catch (error) {
    // No email went out, so the attempt can never be completed: don't keep its password hash.
    await deps.flowAttempts.delete(tenant.environmentId, attempt.id)
    throw error
  }
  return present(attempt, state, secret)
}

/** Sends the attempt's code again (limited per address). */
export async function resendCode(
  deps: Container,
  tenant: Tenant,
  ref: AttemptRef
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_up', ref)
  if (attempt.status !== 'needs_email_verification') {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  await Verification.issue(deps, tenant, {
    flowAttemptId: attempt.id,
    destination: state.email ?? attempt.identifier,
    ...(state.decoy ? { message: (_code, _ttl, to) => accountExistsEmail(to) } : {}),
  })
  return present(attempt, state)
}

/**
 * Completes a sign-up with the emailed code: creates the account and its Organization membership
 * as one step, then the first session.
 *
 * The code is checked first but spent only after the account exists, and the account is written
 * inside a database transaction that the membership call (to the core service) must succeed
 * within: if core refuses, is down or is slow, the transaction rolls back, no account exists, the
 * code is still good and the answer is a contract error. If the process dies after core has made
 * the Organization but before the commit, the retry reuses the same user id and idempotency key,
 * so core returns the same Organization instead of making a second.
 */
export async function verifyEmail(
  deps: Container,
  tenant: Tenant,
  ref: AttemptRef,
  code: string,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_up', ref)
  if (attempt.status !== 'needs_email_verification') {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  const tokenId = await Verification.verifyCode(deps, tenant, { flowAttemptId: attempt.id }, code)
  if (state.decoy || !state.passwordHash || !state.userId) {
    throw fail(AUTH_ERRORS['verification.invalid_code'], { attemptsRemaining: 0 })
  }
  const sign = await Tokens.signer(deps, tenant)
  const now = deps.clock.now()
  const userId = state.userId
  const join: Membership.JoinRequest = state.organizationName
    ? { kind: 'create', name: state.organizationName }
    : {
        kind: 'invitation',
        token: new TextDecoder().decode(
          await deps.secretBox.open(SEAL_PURPOSE, state.sealedInvitation ?? '', attempt.id)
        ),
        email: attempt.identifier,
      }

  let membership: MembershipClaim | undefined
  const created = await deps.users.create(
    {
      id: userId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: state.email ?? attempt.identifier,
      emailNormalized: attempt.identifier,
      emailVerifiedAt: now,
      firstName: state.firstName ?? null,
      lastName: state.lastName ?? null,
      createdAt: now,
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: state.passwordHash,
    },
    async () => {
      membership = await Membership.join(
        deps,
        formatId('usr', userId) as UserId,
        join,
        `signup:${attempt.id}`
      )
    }
  )
  if (!created || !membership) {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  await Verification.consume(deps, tenant, tokenId)
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: 'complete', userId, state: { client: state.client }, completedAt: now },
    now
  )
  if (!moved) {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  const session = await Sessions.create(deps, tenant, {
    userId,
    client: context.client,
    authMethods: ['email'],
    membership,
    sign,
  })
  return {
    id: attempt.id,
    kind: 'sign_up',
    expiresAt: attempt.expiresAt.toISOString(),
    step: { status: 'complete', userId: formatId('usr', userId), sessionId: session.sessionId },
    session,
  }
}

/**
 * Starts a sign-in. The answer is the same for every identifier: the account is not looked up
 * until the password is submitted, so starting one reveals nothing about who has an account.
 */
export async function signIn(
  deps: Container,
  tenant: Tenant,
  input: { identifier: string },
  context: ClientContext
): Promise<FlowResult> {
  const state: State = { client: context.client }
  const { attempt, secret } = await start(deps, tenant, {
    id: deps.ids.next(),
    kind: 'sign_in',
    status: 'needs_password',
    identifier: normalizeEmail(input.identifier),
    state,
  })
  return present(attempt, state, secret)
}

/**
 * Submits the password of a sign-in.
 *
 * Every failure is the same `auth.invalid_credentials`: unknown address, wrong password. An
 * unknown address still costs one password verification. A ban is revealed only to someone who
 * knows the password. Failures back off per identifier (`CREDENTIAL_LOCKOUT`), so the lockout
 * follows the account across attempts; a success clears it.
 *
 * A user with no Organization cannot sign in: no session is created and no token issued, and the
 * deployment is told so it can repair the account.
 */
export async function submitPassword(
  deps: Container,
  tenant: Tenant,
  ref: AttemptRef,
  input: z.infer<typeof passwordRequestSchema>,
  context: ClientContext
): Promise<FlowResult> {
  const { attempt, state } = await load(deps, tenant, 'sign_in', ref)
  if (attempt.status !== 'needs_password') {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  // Counted as a failure up front and cleared on success, so parallel guesses cannot all slip
  // through. It happens before the lookup, so unknown identifiers lock out exactly the same.
  const lockKey = signInLockKey(tenant.environmentId, attempt.identifier)
  const lock = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
  if (!lock.allowed) {
    throw rateLimited(ERRORS['rate.limited'], lock.retryAfterMs)
  }

  const found = await deps.users.findByEmailWithPassword(tenant.environmentId, attempt.identifier)
  if (!(await Passwords.verify(found?.passwordHash ?? null, input.password)) || !found) {
    throw fail(AUTH_ERRORS['auth.invalid_credentials'])
  }
  await deps.lockout.clear(lockKey)
  const { user } = found
  if (user.bannedAt !== null) {
    throw fail(AUTH_ERRORS['auth.user_banned'])
  }
  if (found.passwordHash && Passwords.needsRehash(found.passwordHash)) {
    // Only if the stored hash is still the one just verified.
    await deps.users.upgradePasswordHash(
      tenant.environmentId,
      user.id,
      found.passwordHash,
      await Passwords.hash(input.password),
      deps.clock.now()
    )
  }

  // Before the attempt is spent and before any session: no Organization, no tokens.
  const membership = await Membership.of(deps, formatId('usr', user.id) as UserId)
  if (membership === null) {
    context.report(new Error(`user ${formatId('usr', user.id)} has no Organization`), 403)
    throw fail(AUTH_ERRORS['auth.no_organization'])
  }
  const sign = await Tokens.signer(deps, tenant)
  const now = deps.clock.now()
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    attempt.status,
    { status: 'complete', userId: user.id, state: { client: state.client }, completedAt: now },
    now
  )
  if (!moved) {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  const session = await Sessions.create(deps, tenant, {
    userId: user.id,
    client: context.client,
    authMethods: ['pwd'],
    membership,
    sign,
  })
  await deps.users.recordSignIn(tenant.environmentId, user.id, now)
  return {
    id: attempt.id,
    kind: 'sign_in',
    expiresAt: attempt.expiresAt.toISOString(),
    step: { status: 'complete', userId: formatId('usr', user.id), sessionId: session.sessionId },
    session,
  }
}
