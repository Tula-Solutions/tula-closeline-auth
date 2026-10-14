import {
  AUTH_ERRORS,
  ERRORS,
  formatId,
  GOOGLE_ERROR_PARAM,
  GOOGLE_ERROR_PATH,
  GOOGLE_SIGN_UP_ATTEMPT_PARAM,
  GOOGLE_SIGN_UP_PATH,
  type GoogleCompleteRequest,
  type GoogleIntent,
  type UserId,
} from 'tula-closeline-contract'
import { isAppError } from 'tula-closeline-kit'
import { z } from 'zod'
import type { Container } from '~/container'
import { describeError } from '~/describe-error'
import { fail, MembershipFaulted, rateLimited } from '~/errors'
import { randomToken, sha256Base64Url, sha256Hex, timingSafeEqual } from '~/lib/crypto'
import { durationToMs } from '~/lib/duration'
import { parseEmail } from '~/lib/email'
import { ABANDON_GRACE_MS } from '~/modules/abandon/service'
import { isStorable } from '~/modules/flow/schema'
import {
  ATTEMPT_TTL,
  learnOrganization,
  reportMembershipFault,
  reportOrphan,
  settleOrphan,
} from '~/modules/flow/service'
import { composeMemberName } from '~/modules/membership/profile'
import * as Membership from '~/modules/membership/service'
import * as Sessions from '~/modules/session/service'
import * as Tokens from '~/modules/token/service'
import type { Tenant } from '~/ports/fixed-project'
import type { FlowAttemptRecord } from '~/ports/flow-attempt-store'
import { type GoogleProfile, OidcFailure } from '~/ports/oidc-provider'
import { AbandonCaseClaimed, type UserRecord } from '~/ports/user-repository'

/** Purpose string for sealing the PKCE verifier and the pending profile. */
export const SEAL_PURPOSE = 'oidc-attempt'
/** Prefix of the attempt secret held in the attempt cookie. */
export const OIDC_SECRET_PREFIX = 'tula_oi_'
/** The identifier of an attempt before the callback learns the address (the column is not null). */
export const PENDING_IDENTIFIER = 'google:pending'
/** Where a person lands when `returnTo` was not given or is not on the allow-list. */
export const DEFAULT_RETURN_TO = '/'

/**
 * The portal paths a person may be sent back to: the signed-in areas of the dashboard. A
 * `returnTo` whose path is none of these, or below none of these, is replaced by the default.
 */
export const RETURN_TO_ALLOW_LIST = [
  '/',
  '/invitations',
  '/members',
  '/playbook',
  '/sales-history',
  '/teams',
] as const

/** The rate limits of the three routes, per source and per attempt. */
export const LIMITS = {
  start: { max: 20, windowMs: durationToMs('1m') },
  callback: { max: 30, windowMs: durationToMs('1m') },
  complete: { max: 10, windowMs: durationToMs('1m') },
  options: { max: 120, windowMs: durationToMs('1m') },
  completePerAttempt: { max: 5, windowMs: durationToMs(ATTEMPT_TTL) },
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a Sign in with Google attempt remembers, validated whenever it is read back. */
const stateSchema = z.object({
  client: z.literal('web'),
  provider: z.literal('google'),
  /** SHA-256 of the random half of the `state`; gone once the callback consumed it. */
  stateHash: z.string().optional(),
  /** SHA-256 of the nonce the ID token must carry. */
  nonceHash: z.string(),
  /** The PKCE verifier, sealed; gone once the callback consumed the state. */
  sealedVerifier: z.string().optional(),
  returnTo: z.string(),
  /** What Google reported about a new person, sealed; set when the attempt is pending. */
  sealedProfile: z.string().optional(),
  /** The id the new user will have, fixed up front so a retry is the same sign-up. */
  userId: z.string().optional(),
})
type State = z.infer<typeof stateSchema>

/** Whether the source and attempt limits allow one more call; throws the 429 otherwise. */
async function limit(
  deps: Pick<Container, 'rateLimiter'>,
  key: string,
  policy: { max: number; windowMs: number }
): Promise<void> {
  const decision = await deps.rateLimiter.hit(key, policy.max, policy.windowMs)
  if (!decision.allowed) {
    throw rateLimited(ERRORS['rate.limited'], decision.retryAfterMs)
  }
}

/** Counts one call of `route` against its source's budget. */
export function limitSource(
  deps: Pick<Container, 'rateLimiter'>,
  route: 'start' | 'callback' | 'complete' | 'options',
  source: string
): Promise<void> {
  return limit(deps, `oidc_${route}:src:${source}`, LIMITS[route])
}

/** `returnTo` if it is on the portal's allow-list, else the default. Only the path is compared. */
export function allowedReturnTo(returnTo: string | undefined): string {
  if (returnTo === undefined) {
    return DEFAULT_RETURN_TO
  }
  const path = returnTo.split(/[?#]/)[0] ?? ''
  const allowed = RETURN_TO_ALLOW_LIST.some(
    (prefix) => path === prefix || (prefix !== '/' && path.startsWith(`${prefix}/`))
  )
  return allowed ? returnTo : DEFAULT_RETURN_TO
}

/** Turns what the provider throws into the contract error for the person. */
function translate(error: unknown) {
  if (error instanceof OidcFailure) {
    switch (error.reason) {
      case 'disabled':
        return fail(AUTH_ERRORS['oidc.disabled'])
      case 'unavailable':
        return fail(AUTH_ERRORS['oidc.provider_unavailable'], { retryAfter: 5 })
      case 'email_unverified':
        return fail(AUTH_ERRORS['oidc.email_unverified'])
      default:
        // A refused code, a token that does not verify: this sign-in cannot continue.
        return fail(AUTH_ERRORS['oidc.state_invalid'])
    }
  }
  return error
}

/** Seals a text with the attempt's id as associated data, so it opens only for that attempt. */
function seal(deps: Pick<Container, 'secretBox'>, text: string, attemptId: string) {
  return deps.secretBox.seal(SEAL_PURPOSE, new TextEncoder().encode(text), attemptId)
}

async function unseal(deps: Pick<Container, 'secretBox'>, sealed: string, attemptId: string) {
  return new TextDecoder().decode(await deps.secretBox.open(SEAL_PURPOSE, sealed, attemptId))
}

/** What `start` hands the router: the URL to open and the cookie secret. */
export type Started = { authorizationUrl: string; cookieSecret: string }

/**
 * Starts a Sign in with Google: stores the attempt (state and nonce hashed, the PKCE verifier
 * sealed) and builds the authorization URL.
 *
 * @throws AppError `oidc.disabled`, `oidc.provider_unavailable`.
 */
export async function start(
  deps: Container,
  tenant: Tenant,
  input: { intent: GoogleIntent; returnTo?: string | undefined }
): Promise<Started> {
  if (!deps.oidc.enabled) {
    throw fail(AUTH_ERRORS['oidc.disabled'])
  }
  const id = deps.ids.next()
  const stateRandom = randomToken()
  const nonce = randomToken()
  const verifier = randomToken()
  let authorizationUrl: string
  try {
    authorizationUrl = await deps.oidc.authorizationUrl({
      state: `${id}.${stateRandom}`,
      nonce,
      codeChallenge: sha256Base64Url(verifier),
    })
  } catch (error) {
    throw translate(error)
  }
  const cookieSecret = `${OIDC_SECRET_PREFIX}${randomToken()}`
  const now = deps.clock.now()
  const state: State = {
    client: 'web',
    provider: 'google',
    stateHash: sha256Hex(stateRandom),
    nonceHash: sha256Hex(nonce),
    sealedVerifier: await seal(deps, verifier, id),
    returnTo: allowedReturnTo(input.returnTo),
  }
  await deps.flowAttempts.create({
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    kind: input.intent,
    status: 'oidc_started',
    userId: null,
    identifier: PENDING_IDENTIFIER,
    secretHash: sha256Hex(cookieSecret),
    state,
    expiresAt: new Date(now.getTime() + durationToMs(ATTEMPT_TTL)),
    createdAt: now,
  })
  return { authorizationUrl, cookieSecret }
}

/** What the callback hands the router: where to send the browser and which cookies to set. */
export type CallbackResult = {
  location: string
  clearCookie: boolean
  session?: Sessions.IssuedSession
}

/** The query Google sent the browser back with. */
export type CallbackQuery = { code?: string; state?: string; error?: string }

/** The redirect for a failure: `/sign-in?error=<code>`. */
export function errorLocation(code: string): string {
  return `${GOOGLE_ERROR_PATH}?${new URLSearchParams({ [GOOGLE_ERROR_PARAM]: code }).toString()}`
}

/** Loads the attempt the callback names and checks the state and the cookie, consuming nothing. */
async function openForCallback(
  deps: Container,
  tenant: Tenant,
  query: CallbackQuery,
  cookieSecret: string | undefined
): Promise<{ attempt: FlowAttemptRecord; state: State }> {
  const [id, random] = (query.state ?? '').split('.')
  const attempt =
    id !== undefined && UUID.test(id)
      ? await deps.flowAttempts.findById(tenant.environmentId, id)
      : null
  const parsed = stateSchema.safeParse(attempt?.state)
  // Both comparisons always run, in constant time, even when there is no attempt.
  const stateOk = timingSafeEqual(
    sha256Hex(random ?? ''),
    (parsed.success ? parsed.data.stateHash : undefined) ?? 'x'.repeat(64)
  )
  const cookieOk = timingSafeEqual(
    sha256Hex(cookieSecret ?? ''),
    attempt?.secretHash ?? 'x'.repeat(64)
  )
  if (
    !attempt ||
    !parsed.success ||
    !stateOk ||
    !cookieOk ||
    cookieSecret === undefined ||
    attempt.status !== 'oidc_started' ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= deps.clock.now().getTime()
  ) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  return { attempt, state: parsed.data }
}

/** The name parts to store: Google's given and family names, else the display name as the first. */
function nameParts(profile: GoogleProfile): { firstName: string | null; lastName: string | null } {
  const clean = (text: string | null): string | null => {
    const trimmed = text?.trim().slice(0, 100) ?? ''
    return trimmed !== '' && isStorable(trimmed) ? trimmed : null
  }
  const first = clean(profile.givenName) ?? clean(profile.name)
  return { firstName: first, lastName: clean(profile.familyName) }
}

/**
 * Where Google sends the browser back to. It consumes the state at once (a replay is
 * `oidc.state_invalid`), exchanges the code once, verifies the ID token, and then signs a known
 * Google account in, links a password account with the same address, or sends a new person to
 * name an Organization (creating nothing).
 *
 * @throws AppError: `oidc.disabled` (the only one the route answers as a status), and any other
 *   failure for the router to turn into a redirect to `/sign-in?error=<code>`.
 */
export async function callback(
  deps: Container,
  tenant: Tenant,
  query: CallbackQuery,
  cookieSecret: string | undefined,
  context: { report: (error: unknown, status: number) => void }
): Promise<CallbackResult> {
  if (!deps.oidc.enabled) {
    throw fail(AUTH_ERRORS['oidc.disabled'])
  }
  const { attempt, state } = await openForCallback(deps, tenant, query, cookieSecret)
  const now = deps.clock.now()
  // The first callback to get here spends the state, whatever comes of it.
  const consumed = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    'oidc_started',
    {
      status: 'oidc_exchanging',
      state: {
        client: 'web',
        provider: 'google',
        nonceHash: state.nonceHash,
        returnTo: state.returnTo,
      },
    },
    now
  )
  if (!consumed) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  if (query.error !== undefined) {
    throw fail(
      query.error === 'access_denied'
        ? AUTH_ERRORS['oidc.access_denied']
        : AUTH_ERRORS['oidc.provider_unavailable']
    )
  }
  if (query.code === undefined || query.code === '' || state.sealedVerifier === undefined) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }

  let profile: GoogleProfile
  try {
    const verifier = await unseal(deps, state.sealedVerifier, attempt.id)
    const { idToken } = await deps.oidc.exchangeCode({ code: query.code, codeVerifier: verifier })
    profile = await deps.oidc.verifyIdToken(idToken)
  } catch (error) {
    throw translate(error)
  }
  if (!timingSafeEqual(sha256Hex(profile.nonce), state.nonceHash)) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  // An address ADR 0011 cannot store is refused like any other refusal, not converted.
  const email = parseEmail(profile.email)
  if (email === null) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }

  let user = await deps.users.findByGoogleSubject(tenant.environmentId, profile.subject)
  if (user === null) {
    const holder = await deps.users.findForGoogleLinking(tenant.environmentId, email.normalized)
    if (holder === null) {
      return pendingCompletion(deps, tenant, attempt, state, profile, email.normalized)
    }
    // Only a password account with no Google identity links; anything else, and a banned
    // account, gets the same neutral refusal (nothing says whether the address has an account).
    if (holder.hasGoogle || !holder.hasPassword || holder.user.bannedAt !== null) {
      throw fail(AUTH_ERRORS['oidc.state_invalid'])
    }
    const linked = await deps.users.linkGoogle({
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId: holder.user.id,
      identityId: deps.ids.next(),
      subject: profile.subject,
      auditId: deps.ids.next(),
      at: now,
    })
    if (!linked) {
      // A concurrent link won: carry on only if it was this same account.
      const winner = await deps.users.findByGoogleSubject(tenant.environmentId, profile.subject)
      if (winner?.id !== holder.user.id) {
        throw fail(AUTH_ERRORS['oidc.state_invalid'])
      }
    } else {
      deps.logger.info('a Google account was linked', { userId: holder.user.id })
    }
    user = holder.user
  }
  return signInExisting(deps, tenant, attempt, state, user, context)
}

/** Signs in a user found by their Google account (or just linked), with password sign-in's checks. */
async function signInExisting(
  deps: Container,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  user: UserRecord,
  context: { report: (error: unknown, status: number) => void }
): Promise<CallbackResult> {
  if (user.bannedAt !== null) {
    throw fail(AUTH_ERRORS['auth.user_banned'])
  }
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
    'oidc_exchanging',
    { status: 'complete', userId: user.id, state: { client: 'web' }, completedAt: now },
    now
  )
  if (!moved) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  const session = await Sessions.create(deps, tenant, {
    userId: user.id,
    client: 'web',
    authMethods: ['google'],
    membership,
    sign,
  })
  await deps.users.recordSignIn(tenant.environmentId, user.id, now)
  return { location: state.returnTo, clearCookie: true, session }
}

/** A new person: keep what Google said, sealed, and send them to name an Organization. */
async function pendingCompletion(
  deps: Container,
  tenant: Tenant,
  attempt: FlowAttemptRecord,
  state: State,
  profile: GoogleProfile,
  normalizedEmail: string
): Promise<CallbackResult> {
  const sealedProfile = await seal(
    deps,
    JSON.stringify({
      sub: profile.subject,
      email: profile.email,
      name: profile.name,
      givenName: profile.givenName,
      familyName: profile.familyName,
    }),
    attempt.id
  )
  const moved = await deps.flowAttempts.transition(
    tenant.environmentId,
    attempt.id,
    'oidc_exchanging',
    {
      status: 'oidc_pending',
      identifier: normalizedEmail,
      state: {
        client: 'web',
        provider: 'google',
        nonceHash: state.nonceHash,
        returnTo: state.returnTo,
        sealedProfile,
        userId: deps.ids.next(),
      },
    },
    deps.clock.now()
  )
  if (!moved) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  return {
    location: `${GOOGLE_SIGN_UP_PATH}?${new URLSearchParams({ [GOOGLE_SIGN_UP_ATTEMPT_PARAM]: attempt.id }).toString()}`,
    clearCookie: false,
  }
}

/** The answer to a finished completion. */
export type Completed = {
  id: string
  kind: 'sign_up'
  expiresAt: string
  step: { status: 'complete' }
  session: Sessions.IssuedSession
}

const profileSchema = z.object({
  sub: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
})

/**
 * Finishes the sign-up of a new Google user. The attempt is looked up by id and opened with the
 * cookie's secret. Core is asked first (key `signup:<attempt id>`, so a retry gets the same
 * Organization); only then is the user, their identities and the consumption of the attempt
 * written in ONE transaction. A crash between the two leaves the attempt usable, and a retry
 * finishes. Of two racing calls exactly one consumes the attempt.
 *
 * @throws AppError `oidc.state_invalid`, `oidc.invitation_mismatch`, `membership.unavailable`,
 *   `signup.organization_name_invalid`, `oidc.disabled`.
 */
export async function complete(
  deps: Container,
  tenant: Tenant,
  input: GoogleCompleteRequest,
  cookieSecret: string | undefined,
  context: { report: (error: unknown, status: number) => void }
): Promise<Completed> {
  if (!deps.oidc.enabled) {
    throw fail(AUTH_ERRORS['oidc.disabled'])
  }
  if (!UUID.test(input.attemptId)) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  await limit(deps, `oidc_complete:attempt:${input.attemptId}`, LIMITS.completePerAttempt)
  const attempt = await deps.flowAttempts.findById(tenant.environmentId, input.attemptId)
  const parsed = stateSchema.safeParse(attempt?.state)
  const cookieOk = timingSafeEqual(
    sha256Hex(cookieSecret ?? ''),
    attempt?.secretHash ?? 'x'.repeat(64)
  )
  const now = deps.clock.now()
  if (
    !attempt ||
    !parsed.success ||
    !cookieOk ||
    cookieSecret === undefined ||
    attempt.status !== 'oidc_pending' ||
    attempt.completedAt !== null ||
    attempt.expiresAt.getTime() <= now.getTime() ||
    parsed.data.sealedProfile === undefined ||
    parsed.data.userId === undefined
  ) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  const userId = parsed.data.userId
  const profile = profileSchema.parse(
    JSON.parse(await unseal(deps, parsed.data.sealedProfile, attempt.id))
  )
  const identifier = attempt.identifier

  // The address was free at the callback; if it is not now, this sign-in cannot continue.
  if (
    (await deps.users.findByEmail(tenant.environmentId, identifier)) !== null ||
    (await deps.users.findByGoogleSubject(tenant.environmentId, profile.sub)) !== null
  ) {
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }

  const { firstName, lastName } = nameParts({
    ...profile,
    subject: profile.sub,
    nonce: '',
  })
  const memberName = composeMemberName(firstName, lastName)
  const join: Membership.JoinRequest =
    input.organizationName !== undefined
      ? { kind: 'create', name: input.organizationName, email: identifier, memberName }
      : { kind: 'invitation', token: input.invitationToken ?? '', email: identifier, memberName }

  const sign = await Tokens.signer(deps, tenant)
  const userUuid = formatId('usr', userId) as UserId
  const abandonCaseId = join.kind === 'create' ? attempt.id : undefined
  if (abandonCaseId !== undefined) {
    const recorded = await deps.abandonCases.record({
      id: abandonCaseId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      organizationId: null,
      userId,
      attemptId: attempt.id,
      attemptExpiresAt: attempt.expiresAt,
      graceMs: ABANDON_GRACE_MS,
    })
    if (!recorded) {
      const existing = await deps.abandonCases.find(tenant.environmentId, abandonCaseId)
      if (existing && (existing.resolved || existing.attempts > 0)) {
        throw fail(AUTH_ERRORS['oidc.state_invalid'])
      }
    }
  }
  let membership: Awaited<ReturnType<typeof Membership.join>>
  try {
    membership = await Membership.join(deps, userUuid, join, `signup:${attempt.id}`)
  } catch (error) {
    if (error instanceof MembershipFaulted) {
      await reportMembershipFault(
        deps,
        { client: 'web', report: context.report },
        { userId: userUuid, attemptId: attempt.id }
      )
    }
    if (isAppError(error) && error.code === AUTH_ERRORS['signup.invitation_invalid'].code) {
      // Core answers one thing for an unknown token and for another address; for a Google user
      // the address is the variable, so it is reported as a mismatch.
      throw fail(AUTH_ERRORS['oidc.invitation_mismatch'])
    }
    throw error
  }
  if (abandonCaseId !== undefined) {
    await learnOrganization(deps, { ...context, client: 'web' }, tenant, {
      caseId: abandonCaseId,
      organizationId: membership.organizationId,
      userId: userUuid,
      attemptId: attempt.id,
    })
  }
  const orphan = (why: string, status: number) =>
    reportOrphan(deps, { ...context, client: 'web' }, status, {
      organizationId: membership.organizationId,
      userId: userUuid,
      attemptId: attempt.id,
      why,
    })

  let result: Awaited<ReturnType<typeof deps.users.createGoogleUser>>
  try {
    result = await deps.users.createGoogleUser({
      id: userId,
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      email: profile.email.trim(),
      emailNormalized: identifier,
      emailVerifiedAt: now,
      firstName,
      lastName,
      createdAt: now,
      emailIdentityId: deps.ids.next(),
      googleIdentityId: deps.ids.next(),
      subject: profile.sub,
      consume: { id: attempt.id, from: 'oidc_pending', at: now, state: { client: 'web' } },
      ...(abandonCaseId !== undefined ? { settlesAbandonCase: abandonCaseId } : {}),
    })
  } catch (error) {
    if (error instanceof AbandonCaseClaimed) {
      deps.logger.warn('a Google account lost the race with the abandon sweep', {
        attemptId: attempt.id,
        organizationId: membership.organizationId,
      })
      throw fail(AUTH_ERRORS['oidc.state_invalid'])
    }
    if (!isAppError(error)) {
      await orphan('the Google account could not be written', 500)
      deps.logger.error('writing a Google account failed', { error: describeError(error) })
    }
    throw error
  }
  if (result === 'conflict') {
    // The address or the Google account went to someone else since the check: this attempt can
    // never write its account, which is the one case a request may abandon the Organization.
    await settleOrphan(deps, { ...context, client: 'web' }, 409, {
      organizationId: membership.organizationId,
      userId: userUuid,
      attemptId: attempt.id,
      why: 'the address or Google account went to another user',
      abandon: join.kind === 'create',
      ...(abandonCaseId !== undefined
        ? { abandonCase: { id: abandonCaseId, environmentId: tenant.environmentId } }
        : {}),
    })
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  if (result === 'consumed') {
    // A racing call (or expiry) took the attempt between the check and the write.
    throw fail(AUTH_ERRORS['oidc.state_invalid'])
  }
  const session = await Sessions.create(deps, tenant, {
    userId,
    client: 'web',
    authMethods: ['google'],
    membership,
    sign,
  })
  await deps.users.recordSignIn(tenant.environmentId, userId, now)
  return {
    id: attempt.id,
    kind: 'sign_up',
    expiresAt: attempt.expiresAt.toISOString(),
    step: { status: 'complete' },
    session,
  }
}
