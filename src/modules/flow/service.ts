import {
  AUTH_ERRORS,
  ERRORS,
  formatId,
  type OrganizationId,
  type UserId,
} from 'tula-closeline-contract'
import { isAppError } from 'tula-closeline-kit'
import { z } from 'zod'
import { type Container, reportSafely } from '~/container'
import { describeError } from '~/describe-error'
import { fail, MembershipFaulted, MembershipOutage, rateLimited } from '~/errors'
import { resolveRequestId } from '~/http/request-id'
import { randomToken, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { durationToMs } from '~/lib/duration'
import { maskEmail, normalizeEmail, parseEmail } from '~/lib/email'
import { ABANDON_GRACE_MS } from '~/modules/abandon/service'
import { composeMemberName } from '~/modules/membership/profile'
import * as Membership from '~/modules/membership/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Tokens from '~/modules/token/service'
import { accountExistsEmail } from '~/modules/verification/mail'
import * as Verification from '~/modules/verification/service'
import type { Tenant } from '~/ports/fixed-project'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import {
  CREDENTIAL_LOCKOUT,
  KNOWN_DEVICE_LOCKOUT,
  knownDeviceLockKey,
  signInLockKey,
} from '~/ports/lockout'
import type { SessionClient } from '~/ports/session-store'
import { type KnownDevice, newDeviceId, setDeviceCookie } from './device-cookie'
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
  /** The `browser` client type: the refresh token goes in a cookie, not the body. */
  cookie?: boolean
  /**
   * The device the request's known-device cookie vouches for (ADR 0014), or `null`: a missing,
   * tampered, expired or malformed cookie is `null`. Read when called, so only a sign-in pays.
   */
  knownDevice?: () => KnownDevice | null
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
  /**
   * The `Set-Cookie` value that marks the device as known, on a `browser` sign-in that succeeded.
   * The router sets it as a header and removes it from the body.
   */
  deviceCookie?: string
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
  // Cheapest first, so a request that will be refused costs as little as possible: the local
  // policy, then a hash slot, and inside it the per-address send limit, the breach lookup (a
  // third party, with a slot of its own) and the hash (64 MiB, a core). A request is counted
  // against an address only once it holds the slots it needs, so one that is shed (a 503 the
  // client retries) costs the address nothing, and an address over its hourly cap makes neither
  // the lookup nor the hash. A refusal writes nothing.
  const normalizedPassword = Passwords.checkPolicy(input.password, {
    email,
    firstName: firstName ?? undefined,
    lastName: lastName ?? undefined,
  })
  const passwordHash = await Passwords.inLane(deps, 'hash', async () => {
    await Passwords.checkBreach(deps, normalizedPassword, () =>
      Verification.enforceSendLimits(deps, tenant, identifier)
    )
    return Passwords.hashHeld(input.password)
  })

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
      limitsEnforced: true,
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
 * Runs bookkeeping whose failure must not change the answer: a failure is logged (ids only), not
 * raised. `failure` is the whole log message, so it says what failed on that path.
 */
async function bestEffort(
  deps: Pick<Container, 'logger'>,
  failure: string,
  attemptId: string,
  work: () => Promise<void>
): Promise<void> {
  try {
    await work()
  } catch (error) {
    deps.logger.warn(failure, {
      attemptId,
      error: describeError(error),
    })
  }
}

/** The longest the tracker is told about one attempt's unowned Organization: once an hour. */
export const ORPHAN_REPORT_WINDOW_MS = durationToMs('1h')

/**
 * Tells the deployment that core made an Organization for a sign-up whose account was not written
 * (ids only, never an address), so it can be reconciled (ticket 1.9). Logged every time, reported
 * to the tracker once per attempt per hour, so that retries of one attempt, or attempts made on
 * purpose, cannot flood it. It never throws. Exported for its tests.
 */
export async function reportOrphan(
  deps: Pick<Container, 'logger' | 'rateLimiter'>,
  context: ClientContext,
  status: number,
  orphan: { organizationId: string; userId: string; attemptId: string; why: string }
): Promise<void> {
  const { organizationId, userId, attemptId, why } = orphan
  try {
    deps.logger.warn('an Organization has no owner', { organizationId, userId, attemptId, why })
    const first = await deps.rateLimiter.hit(
      `orphan_report:${attemptId}`,
      1,
      ORPHAN_REPORT_WINDOW_MS
    )
    if (first.allowed) {
      context.report(
        new Error(
          `organization ${organizationId} has no owner: user ${userId} was not written ` +
            `(${why}; attempt ${attemptId}); reconcile`
        ),
        status
      )
    }
  } catch {
    // Reporting must never change what the caller is told.
  }
}

/**
 * Deals with an Organization that core made for a sign-up whose account was not written: asks core
 * to abandon it (when `abandon` is true) with the key `abandon:<attempt id>`, and reports it to
 * the tracker (ids only, once per attempt per hour, as {@link reportOrphan}) only if it is still
 * there afterwards: core refused, or could not be asked within the bound. It never throws, and the
 * failed sign-up's answer is not changed by what it finds. Exported for its tests.
 */
export async function settleOrphan(
  deps: Pick<Container, 'logger' | 'rateLimiter' | 'membership' | 'abandonCases'>,
  context: ClientContext,
  status: number,
  orphan: {
    organizationId: string
    userId: string
    attemptId: string
    why: string
    abandon: boolean
    /** The abandon case to resolve with the answer (a bare uuid), and its environment. */
    abandonCase?: { id: string; environmentId: string }
  }
): Promise<void> {
  const { abandon, abandonCase, ...ids } = orphan
  let outcome: Membership.AbandonOutcome | 'not_asked' = 'not_asked'
  if (abandon) {
    try {
      outcome = await Membership.abandon(deps, {
        organizationId: ids.organizationId as OrganizationId,
        userId: ids.userId as UserId,
        idempotencyKey: `abandon:${ids.attemptId}`,
      })
    } catch {
      outcome = 'unfinished'
    }
  }
  // The answer is final for `done` and `refused`; an unfinished abandon leaves the case open for
  // the sweep. A failed resolve is harmless: the sweep abandons again (core's answer is by end
  // state) and resolves then.
  if (abandonCase && (outcome === 'done' || outcome === 'refused')) {
    try {
      await deps.abandonCases.resolve(abandonCase.environmentId, abandonCase.id, outcome)
    } catch {
      deps.logger.warn('an abandon case could not be resolved', { caseId: abandonCase.id })
    }
  }
  if (outcome === 'done') {
    deps.logger.warn('an Organization with no owner was abandoned', ids)
    return
  }
  await reportOrphan(deps, context, status, {
    ...ids,
    why: `${ids.why}; abandon ${outcome === 'not_asked' ? 'not asked' : outcome}`,
  })
}

/**
 * Fills in the Organization id of the attempt's abandon case once core has answered. Best effort:
 * if it fails the case stays unlearned and the sweep finds the Organization by the user id. A
 * unique violation (another case already holds this Organization) resolves this case as
 * `gave_up` in a new transaction and is reported by ids; the sign-up goes on. Never throws.
 */
async function learnOrganization(
  deps: Pick<Container, 'logger' | 'abandonCases' | 'reportError'>,
  _context: ClientContext,
  tenant: Tenant,
  found: { caseId: string; organizationId: string; userId: string; attemptId: string }
): Promise<void> {
  const { caseId, organizationId, userId, attemptId } = found
  try {
    const learned = await deps.abandonCases.learn(tenant.environmentId, caseId, organizationId)
    if (learned === 'conflict') {
      await deps.abandonCases.resolve(tenant.environmentId, caseId, 'gave_up')
      deps.logger.warn('another abandon case already holds this Organization', {
        caseId,
        organizationId,
        userId,
        attemptId,
      })
      reportSafely(
        deps,
        new Error(
          `abandon case ${caseId} (user ${userId}, attempt ${attemptId}) found organization ` +
            `${organizationId}, which another case already holds; reconcile`
        ),
        { requestId: resolveRequestId(undefined), method: 'POST', path: 'sign-up', status: 500 }
      )
    }
  } catch (error) {
    deps.logger.warn('the Organization id could not be recorded on the abandon case', {
      caseId,
      attemptId,
      error: describeError(error),
    })
  }
}

/**
 * Tells the deployment that core said a brand new user already belongs to an Organization (a
 * fault on one side: auth makes the user id for this attempt alone). Ids only, never an address.
 * Logged every time, reported to the tracker once per attempt per hour, so a client retrying
 * cannot flood it. It never throws. Exported for its tests.
 */
export async function reportMembershipFault(
  deps: Pick<Container, 'logger' | 'rateLimiter'>,
  context: ClientContext,
  fault: { userId: string; attemptId: string }
): Promise<void> {
  const { userId, attemptId } = fault
  try {
    deps.logger.warn('core says a new user already belongs to an Organization', {
      userId,
      attemptId,
    })
    const first = await deps.rateLimiter.hit(
      `membership_fault:${attemptId}`,
      1,
      ORPHAN_REPORT_WINDOW_MS
    )
    if (first.allowed) {
      context.report(
        new Error(
          `core says user ${userId} already belongs to an Organization (attempt ${attemptId}); ` +
            'a sign-up makes a new user id, so one side is at fault'
        ),
        500
      )
    }
  } catch {
    // Reporting must never change what the caller is told.
  }
}

/**
 * Completes a sign-up with the emailed code: creates the account and its Organization membership,
 * then the first session.
 *
 * No database transaction is held across the call to core (it can take 5 seconds, and a few
 * of them would starve the pool). The order is: the address is checked free; core is asked for the
 * Organization with the attempt's idempotency key (`signup:<attempt id>`) and the user id fixed
 * when the attempt started, so a retry gets the same Organization instead of a second; then the
 * account is written in one short transaction. An insert that finds this same user id already
 * there is a retry that crashed after committing, and counts as done. An insert that loses the
 * address to a different sign-up, or fails for another reason, leaves an Organization with no
 * owner: the first is answered like a taken address, and either is reported (ids only, once per
 * attempt per hour) for reconciliation (ticket 1.9).
 *
 * The code is checked first but spent only after the account exists, and spending it and closing
 * the attempt are best-effort: once the account is committed a failure of either (a thrown
 * error) cannot turn a completed sign-up into an error (the user can always sign in). Only the
 * answer "already spent" is refused, which is what keeps a code single-use. If core refuses or is
 * down, nothing was written, the code is still good and the answer is a contract error; when core
 * is down the try the code cost is given back, so an outage never uses up a correct code. A fault
 * in core (it says the new user is already a member) is a 500 that is reported once per attempt;
 * its try is not given back.
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
  // Core keeps a copy of the verified address (as normalized, the form its checks fold to) and
  // the person's name for the member list (ADR 0015).
  const memberName = composeMemberName(state.firstName, state.lastName)
  if (memberName === null && [state.firstName, state.lastName].some((part) => part?.trim())) {
    // A name was given but nothing of it can go to core: say so by attempt id, never the value.
    deps.logger.warn('a name could not be sent to core', { attemptId: attempt.id })
  }
  const join: Membership.JoinRequest = state.organizationName
    ? {
        kind: 'create',
        name: state.organizationName,
        email: attempt.identifier,
        memberName,
      }
    : {
        kind: 'invitation',
        token: new TextDecoder().decode(
          await deps.secretBox.open(SEAL_PURPOSE, state.sealedInvitation ?? '', attempt.id)
        ),
        email: attempt.identifier,
        memberName,
      }

  // Most taken addresses are caught here, before core is asked for an Organization nobody owns.
  const holder = await deps.users.findByEmail(tenant.environmentId, attempt.identifier)
  if (holder && holder.id !== userId) {
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  const userUuid = formatId('usr', userId) as UserId
  // An Owner's sign-up is recorded before core is asked, in a transaction of its own, so a crash
  // between core's answer and the account insert cannot lose the Organization. If it cannot be
  // recorded nothing is created at core and the request fails (500, nothing to undo). An
  // invitation sign-up joins an Organization with other members and is never recorded.
  const abandonCaseId = join.kind === 'create' ? attempt.id : undefined
  if (abandonCaseId !== undefined) {
    await deps.abandonCases.record({
      id: abandonCaseId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: null,
      userId,
      attemptId: attempt.id,
      attemptExpiresAt: attempt.expiresAt,
      graceMs: ABANDON_GRACE_MS,
    })
  }
  let membership: Awaited<ReturnType<typeof Membership.join>>
  try {
    membership = await Membership.join(deps, userUuid, join, `signup:${attempt.id}`)
  } catch (error) {
    if (error instanceof MembershipOutage) {
      // The code matched and core could not be asked: that try is not the person's to lose.
      await bestEffort(
        deps,
        'giving back the verification try failed after core was unavailable',
        attempt.id,
        () => Verification.refundAttempt(deps, tenant, tokenId)
      )
    } else if (error instanceof MembershipFaulted) {
      // A fault that retrying cannot clear: the try stays spent, so the code runs out.
      await reportMembershipFault(deps, context, { userId: userUuid, attemptId: attempt.id })
    }
    throw error
  }
  if (abandonCaseId !== undefined) {
    await learnOrganization(deps, context, tenant, {
      caseId: abandonCaseId,
      organizationId: membership.organizationId,
      userId: userUuid,
      attemptId: attempt.id,
    })
  }
  // From here core has made an Organization: if the account is not written, nobody owns it.
  // The request abandons it in exactly one case (below): the address is held by a different
  // user. Every other failure is only reported, because nothing in this process can prove the
  // account will never be written while the attempt is still usable (a double submit of the same
  // attempt, or a commit that outlived a dropped connection, would make the abandon delete a
  // working Owner's Organization). Abandoning those is left to a sweep that waits until the
  // attempt can no longer write an account and a read shows none.
  const report = (why: string, status: number) =>
    reportOrphan(deps, context, status, {
      organizationId: membership.organizationId,
      userId: userUuid,
      attemptId: attempt.id,
      why,
    })
  let created: boolean
  try {
    created = await deps.users.create({
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
      ...(abandonCaseId !== undefined ? { resolvesAbandonCase: abandonCaseId } : {}),
    })
    if (!created) {
      // A unique violation: this user id, or this address, is already taken.
      const mine = await deps.users.findById(tenant.environmentId, userId)
      if (mine?.emailNormalized !== attempt.identifier) {
        const holder = await deps.users.findByEmail(tenant.environmentId, attempt.identifier)
        if (holder !== null && holder.id !== userId && mine === null) {
          // Proven by reading who owns the address: a different user, and this user id has no
          // account, so this attempt's account can never be written. The only abandon in a request.
          await settleOrphan(deps, context, 409, {
            organizationId: membership.organizationId,
            userId: userUuid,
            attemptId: attempt.id,
            why: 'the address went to another sign-up',
            abandon: join.kind === 'create',
            ...(abandonCaseId !== undefined
              ? { abandonCase: { id: abandonCaseId, environmentId: tenant.environmentId } }
              : {}),
          })
        } else {
          await report('the account could not be written and no other holder was proven', 409)
        }
        throw fail(AUTH_ERRORS['flow.invalid_step'])
      }
      // Otherwise the account is this attempt's own (an earlier request of it committed): done.
    }
  } catch (error) {
    if (!isAppError(error)) {
      await report('the account could not be written', 500)
    }
    throw error
  }
  let spent: boolean | undefined
  await bestEffort(
    deps,
    'spending the code failed after the account was committed',
    attempt.id,
    async () => {
      spent = await deps.verificationTokens.consume(tenant.environmentId, tokenId, now)
    }
  )
  if (spent === false) {
    // The code is single-use: another request with it got here first and is finishing the
    // sign-up (same account, so nothing is lost), or the code ran out as this request finished.
    throw fail(AUTH_ERRORS['flow.invalid_step'])
  }
  await bestEffort(
    deps,
    'closing the attempt failed after the account was committed',
    attempt.id,
    async () => {
      await deps.flowAttempts.transition(
        tenant.environmentId,
        attempt.id,
        attempt.status,
        { status: 'complete', userId, state: { client: state.client }, completedAt: now },
        now
      )
    }
  )
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
 * follows the account across attempts; a success clears it. A device that has signed in to the
 * account before is not refused for other people's wrong tries (ADR 0014), but its own are
 * counted separately.
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
  // A password no account can have is refused before anything is counted, as a wrong one.
  if (!Passwords.withinLimit(input.password)) {
    throw fail(AUTH_ERRORS['auth.invalid_credentials'])
  }
  // Everything that counts against the account happens inside a sign-in slot, so a request that
  // is shed (a 503 the client retries) is never counted. The try is counted as a failure up
  // front and cleared on success, so parallel guesses cannot all slip through. It happens before
  // the lookup, so unknown identifiers lock out exactly the same, and an unknown identifier still
  // pays for one verification in the same lane.
  //
  // Known devices (ADR 0014): an address locked by wrong tries refuses every device but one that
  // carries a valid cookie for the account that address belongs to. That device is not refused
  // for the address's lockout, but its own wrong tries count against a counter of its own
  // (account and device), so a copied cookie cannot guess without limit. Any other cookie
  // (missing, tampered, expired, for another account) is treated as no cookie, with the same
  // answer. A locked address costs a request with no valid cookie nothing beyond the counter.
  const lockKey = signInLockKey(tenant.environmentId, attempt.identifier)
  const cookieDevice = context.knownDevice?.() ?? null
  const { user, device } = await Passwords.inLane(deps, 'signIn', async () => {
    const address = await deps.lockout.attempt(lockKey, CREDENTIAL_LOCKOUT, deps.clock.now())
    if (!address.allowed && cookieDevice === null) {
      throw rateLimited(ERRORS['rate.limited'], address.retryAfterMs)
    }
    const found = await deps.users.findByEmailWithPassword(tenant.environmentId, attempt.identifier)
    const known = found && found.user.id === cookieDevice?.userId ? cookieDevice : null
    if (!address.allowed && known === null) {
      throw rateLimited(ERRORS['rate.limited'], address.retryAfterMs)
    }
    const deviceKey =
      known === null ? null : knownDeviceLockKey(tenant.environmentId, known.userId, known.deviceId)
    if (deviceKey !== null) {
      const own = await deps.lockout.attempt(deviceKey, KNOWN_DEVICE_LOCKOUT, deps.clock.now())
      if (!own.allowed) {
        throw rateLimited(ERRORS['rate.limited'], own.retryAfterMs)
      }
    }
    if (!(await Passwords.verifyHeld(found?.passwordHash ?? null, input.password)) || !found) {
      throw fail(AUTH_ERRORS['auth.invalid_credentials'])
    }
    // A right password forgets what this device and (unless the address was locked by other
    // people's guesses, which a success from a known device does not end) the address counted.
    if (deviceKey !== null) {
      await deps.lockout.clear(deviceKey)
    }
    if (address.allowed) {
      await deps.lockout.clear(lockKey)
    }
    if (found.user.bannedAt !== null) {
      throw fail(AUTH_ERRORS['auth.user_banned'])
    }
    if (found.passwordHash && Passwords.needsRehash(found.passwordHash)) {
      // Only if the stored hash is still the one just verified.
      await deps.users.upgradePasswordHash(
        tenant.environmentId,
        found.user.id,
        found.passwordHash,
        await Passwords.hashHeld(input.password),
        deps.clock.now()
      )
    }
    return { user: found.user, device: known }
  })

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
    // A browser remembers the device (renewing the cookie it already had); other clients have
    // no cookie jar to hold it.
    ...(context.cookie
      ? {
          deviceCookie: setDeviceCookie(
            deps.env,
            { userId: user.id, deviceId: device?.deviceId ?? newDeviceId() },
            now
          ),
        }
      : {}),
  }
}
