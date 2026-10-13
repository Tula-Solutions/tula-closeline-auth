import {
  CORE_ERRORS,
  type CoreErrorCode,
  emailSchema,
  errorBodySchema,
  INTERNAL_CALL_ERRORS,
  type InternalCallName,
  idempotencyKeySchema,
  internalAbandonOrganizationParamsSchema,
  internalAbandonOrganizationRequestSchema,
  internalAbandonOrganizationResponseSchema,
  internalAcceptInvitationRequestSchema,
  internalAcceptInvitationResponseSchema,
  internalCreateOrganizationRequestSchema,
  internalCreateOrganizationResponseSchema,
  internalMembershipRequestSchema,
  internalMembershipResponseSchema,
  invitationTokenSchema,
  organizationNameSchema,
} from 'tula-closeline-contract'
import {
  createInternalClient,
  type Environment,
  InternalCallError,
  type InternalClient,
  type Logger,
} from 'tula-closeline-kit'
import type { z } from 'zod'
import { createConcurrencyLimiter, Saturated } from '~/lib/concurrency'
import {
  type Membership,
  MembershipBusy,
  type MembershipClaims,
  MembershipFault,
  MembershipNotAbandonable,
  MembershipNotRetryable,
  MembershipRefused,
  MembershipRejected,
  MembershipUnavailable,
} from '~/ports/membership'

/**
 * The longest one attempt of the membership lookup may take. The caller gives up on any call
 * after 5 s (`MEMBERSHIP_TIMEOUT_MS`); two attempts and the pause between them must fit inside
 * that, so the second attempt is never cut off mid-flight: 2 s + 0.15 s + 2 s = 4.15 s. The
 * lookup is two indexed reads in core, so 2 s is far above its normal latency.
 */
export const LOOKUP_ATTEMPT_TIMEOUT_MS = 2_000

/**
 * The longest a sign-up call (create an Organization, accept an Invitation) may take. They write,
 * so they are tried once here; a retry is the flow's, under the same idempotency key. Just under
 * the caller's 5 s bound, so this adapter normally reports the failure first.
 */
export const WRITE_TIMEOUT_MS = 4_500

/** The pause before the lookup's one retry: 50 to 150 ms, so instances do not retry in step. */
function defaultRetryDelayMs(): number {
  return 50 + Math.random() * 100
}

/** How many calls to core one instance has in flight at once, unless configured otherwise. */
export const DEFAULT_CORE_CONCURRENCY = 64

/** How many more calls may wait for a slot, unless configured otherwise. */
export const DEFAULT_CORE_QUEUE = 256

/** The largest answer from core that is read; the real ones are under 300 bytes. */
const MAX_ANSWER_BYTES = 16 * 1024

/** Options for {@link createHttpMembership}. */
export type HttpMembershipOptions = {
  /** Core's origin, such as `https://core.internal`; no trailing slash needed. */
  baseUrl: string
  /** The shared secret core expects as a bearer token. Never logged or put in an error. */
  token: string
  /** Where a retry is noted. It receives fixed words and numbers, never a body or a header. */
  logger?: Pick<Logger, 'warn'>
  /**
   * Where this deployment runs. The kit's client refuses to be built when
   * `NODE_TLS_REJECT_UNAUTHORIZED=0` is set outside `local`, which surfaces as a boot error.
   */
  environment: Environment
  /** One lookup attempt's bound; defaults to {@link LOOKUP_ATTEMPT_TIMEOUT_MS}. */
  lookupTimeoutMs?: number
  /** A sign-up call's bound; defaults to {@link WRITE_TIMEOUT_MS}. */
  writeTimeoutMs?: number
  /** How long to pause before the lookup's retry; defaults to a jittered 50 to 150 ms. */
  retryDelayMs?: () => number
  /** The most requests to core in flight at once; defaults to {@link DEFAULT_CORE_CONCURRENCY}. */
  concurrency?: number
  /**
   * How many more calls may wait for a slot; past that a call fails as unavailable at once.
   * Defaults to {@link DEFAULT_CORE_QUEUE}.
   */
  queue?: number
}

/**
 * Core answered 401 or 403: the shared secret is wrong or not configured over there. A
 * deployment fault, not a transient one, so it is never retried; the error handler reports it
 * under this class name (no secret), at most once a minute, and the user sees 503 like any outage.
 */
export class CoreCredentialsRejected extends MembershipRejected {
  constructor(status: number) {
    super(`core refused the service credentials (HTTP ${status}); check CORE_INTERNAL_TOKEN`)
    this.name = 'CoreCredentialsRejected'
  }
}

/**
 * Every slot for calls to core is taken and so is every place in the line: the call is refused at
 * once, unsent, as unavailable, so a stalled core cannot make this instance pile up requests
 * (and memory) behind it.
 */
class CoreSaturated extends MembershipUnavailable {
  constructor() {
    super('too many calls to core are in flight')
    this.name = 'CoreSaturated'
  }
}

/** A failed attempt, and whether trying again could help (the caller did not give up). */
class AttemptFailed extends MembershipUnavailable {
  readonly retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'AttemptFailed'
    this.retryable = retryable
  }
}

/**
 * What an exchange with core produced: the status and the JSON body when it was a usable one.
 */
type Answer = { status: number; json: unknown }

/** Resolves after `ms`, or rejects as an aborted call when `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      reject(new MembershipUnavailable('the call was aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }, ms)
    if (signal?.aborted) {
      aborted()
      return
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/**
 * The membership port over HTTP to the core service's internal routes (ADR 0005). Every call
 * carries `Authorization: Bearer <shared secret>` and an `Idempotency-Key`; every answer is
 * checked against the contract's schema and anything else is unavailable.
 *
 * At most `concurrency` requests are in flight and `queue` more wait; past that a call fails as
 * unavailable at once (a stalled core cannot pile requests up here). The caller's bound covers the
 * wait for a slot too.
 *
 * Retries: only the lookup (a read), once, after a jittered pause, on a network error, a timeout
 * of the attempt, or a 5xx. The sign-up calls are tried once: the flow retries the whole attempt
 * under the same key. A redirect is never followed (it would carry the secret to another host).
 * This is the only layer that retries: the kit client is built with one attempt.
 * No message or log line made here contains the secret, a token, an address or a response body.
 */
export function createHttpMembership(options: HttpMembershipOptions): MembershipClaims {
  const lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_ATTEMPT_TIMEOUT_MS
  const writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs
  // The kit's client is the only transport: `node:http(s)` with no agent, so a proxy variable in
  // the environment is never read (ADR 0013). Its own retry is turned down to one attempt: the
  // retry rules below are this adapter's (a read, once, on any 5xx), and a second layer would
  // multiply the attempts and the time bound.
  const core: InternalClient = createInternalClient({
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    secret: options.token,
    environment: options.environment,
    userAgent: 'closeline-auth',
    maxResponseBytes: MAX_ANSWER_BYTES,
    retry: { maxAttempts: 1 },
  })

  const limiter = createConcurrencyLimiter({
    concurrency: options.concurrency ?? DEFAULT_CORE_CONCURRENCY,
    queue: options.queue ?? DEFAULT_CORE_QUEUE,
  })

  /** One request to core. Throws {@link AttemptFailed} when no answer could be had. */
  const callCore = async (
    path: string,
    payload: unknown,
    idempotencyKey: string,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined
  ): Promise<Answer> => {
    if (callerSignal?.aborted) {
      throw new AttemptFailed('the call was aborted', false)
    }
    try {
      const response = await core.request({
        method: 'POST',
        path,
        body: payload,
        idempotencyKey,
        timeoutMs,
        ...(callerSignal === undefined ? {} : { signal: callerSignal }),
      })
      // Only an answer that can be used is read: a 5xx or an odd status is not.
      const readable = response.status === 200 || (response.status >= 400 && response.status < 500)
      return { status: response.status, json: readable ? response.json : undefined }
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new AttemptFailed('the call was aborted', false)
      }
      // The failure kind only: the client's error carries no secret or body, and nothing else is
      // copied from it. A redirect, an oversized or non-JSON answer cannot change on a retry.
      if (error instanceof InternalCallError) {
        const retryable = error.failure === 'connection' || error.failure === 'timeout'
        throw new AttemptFailed(
          error.failure === 'timeout'
            ? 'core did not answer in time'
            : `core could not be used (${error.failure})`,
          retryable
        )
      }
      throw new AttemptFailed('core could not be called', false)
    }
  }

  /**
   * One request to core, inside the concurrency limit. The limit covers only the request: a
   * lookup's pause before its retry holds no slot. A caller that gave up while waiting for a slot
   * sends nothing when its turn comes. Throws {@link CoreSaturated} when the line is full.
   */
  const exchange = async (
    path: string,
    payload: unknown,
    idempotencyKey: string,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined
  ): Promise<Answer> => {
    try {
      return await limiter.run(() =>
        callCore(path, payload, idempotencyKey, timeoutMs, callerSignal)
      )
    } catch (error) {
      throw error instanceof Saturated ? new CoreSaturated() : error
    }
  }

  /** The exchange, with one more try for a read that failed in a way that can pass. */
  const send = async (
    path: string,
    payload: unknown,
    idempotencyKey: string,
    mode: { retry: boolean; timeoutMs: number },
    signal: AbortSignal | undefined
  ): Promise<Answer> => {
    const key = idempotencyKeySchema.safeParse(idempotencyKey)
    if (!key.success) {
      throw new MembershipUnavailable('the idempotency key is not one core accepts')
    }
    const attempts = mode.retry ? 2 : 1
    for (let attempt = 1; ; attempt += 1) {
      try {
        const answer = await exchange(path, payload, key.data, mode.timeoutMs, signal)
        if (answer.status < 500 || attempt >= attempts) {
          return answer
        }
        options.logger?.warn('core membership call failed, retrying', { status: answer.status })
      } catch (error) {
        if (!(error instanceof AttemptFailed) || !error.retryable || attempt >= attempts) {
          throw error
        }
        options.logger?.warn('core membership call failed, retrying', { reason: error.message })
      }
      await pause(retryDelayMs(), signal)
    }
  }

  /** Reads the answer with the call's schema; anything the contract does not describe fails. */
  const accept = <S extends z.ZodType>(schema: S, answer: Answer): z.output<S> => {
    const parsed = schema.safeParse(answer.json)
    if (!parsed.success) {
      throw new MembershipUnavailable('core answered something the contract does not describe')
    }
    return parsed.data
  }

  /** Turns a non-200 answer into the port's error: a refusal core is allowed to give, or a fault. */
  const refuse = (call: InternalCallName, answer: Answer): never => {
    if (answer.status === 401 || answer.status === 403) {
      throw new CoreCredentialsRejected(answer.status)
    }
    const code = errorBodySchema.safeParse(answer.json).data?.error.code
    const allowed: readonly CoreErrorCode[] = INTERNAL_CALL_ERRORS[call]
    const known = allowed.find((candidate) => candidate === code)
    if (known !== undefined && CORE_ERRORS[known].status === answer.status) {
      if (known === 'invitation.invalid') {
        throw new MembershipRefused('invitation_invalid')
      }
      if (known === 'organization.not_abandonable') {
        throw new MembershipNotAbandonable()
      }
      // Auth makes a fresh user id for every sign-up attempt, so core saying the user already
      // belongs to an Organization is a fault on one side: retrying cannot clear it and the
      // person cannot fix it, so it is not the outage that `membership.unavailable` means.
      throw new MembershipFault('core says the user already belongs to an Organization')
    }
    throw new MembershipUnavailable(`core answered HTTP ${answer.status}`)
  }

  return {
    async createOrganization({
      userId,
      name,
      email,
      memberName,
      idempotencyKey,
      signal,
    }): Promise<Membership> {
      if (!organizationNameSchema.safeParse(name).success) {
        throw new MembershipRefused('organization_name_invalid')
      }
      const request = internalCreateOrganizationRequestSchema.safeParse({
        userId,
        organizationName: name,
        email,
        name: memberName,
      })
      if (!request.success) {
        throw new MembershipUnavailable('the request is not one the contract describes')
      }
      const answer = await send(
        '/internal/organizations',
        request.data,
        idempotencyKey,
        { retry: false, timeoutMs: writeTimeoutMs },
        signal
      )
      return answer.status === 200
        ? accept(internalCreateOrganizationResponseSchema, answer)
        : refuse('createOrganization', answer)
    },

    async acceptInvitation({
      userId,
      invitationToken,
      email,
      memberName,
      idempotencyKey,
      signal,
    }): Promise<Membership> {
      // A token or address of a shape the contract forbids cannot belong to any Invitation.
      if (
        !invitationTokenSchema.safeParse(invitationToken).success ||
        !emailSchema.safeParse(email).success
      ) {
        throw new MembershipRefused('invitation_invalid')
      }
      const request = internalAcceptInvitationRequestSchema.safeParse({
        userId,
        email,
        name: memberName,
        invitationToken,
      })
      if (!request.success) {
        throw new MembershipUnavailable('the request is not one the contract describes')
      }
      const answer = await send(
        '/internal/invitations/accept',
        request.data,
        idempotencyKey,
        { retry: false, timeoutMs: writeTimeoutMs },
        signal
      )
      return answer.status === 200
        ? accept(internalAcceptInvitationResponseSchema, answer)
        : refuse('acceptInvitation', answer)
    },

    async abandonOrganization({ organizationId, userId, idempotencyKey, signal }): Promise<void> {
      const params = internalAbandonOrganizationParamsSchema.safeParse({ organizationId })
      const request = internalAbandonOrganizationRequestSchema.safeParse({ userId })
      if (!params.success || !request.success) {
        throw new MembershipUnavailable('the request is not one the contract describes')
      }
      // One try: the caller retries under the same key, inside its own bound.
      const answer = await send(
        `/internal/organizations/${params.data.organizationId}/abandon`,
        request.data,
        idempotencyKey,
        { retry: false, timeoutMs: writeTimeoutMs },
        signal
      )
      if (answer.status === 503) {
        // The kit's client does not hand back headers, so core's `Retry-After` is not known here;
        // the abandon loop uses its own pause.
        throw new MembershipBusy(undefined, 'core answered HTTP 503')
      }
      if (answer.status !== 200) {
        try {
          refuse('abandonOrganization', answer)
        } catch (error) {
          // A 4xx other than the guard's 409 means the request is what core refused: asking
          // again changes nothing. (A rejected secret is not retried either.)
          if (
            answer.status >= 400 &&
            answer.status < 500 &&
            !(error instanceof MembershipNotAbandonable) &&
            !(error instanceof MembershipRejected)
          ) {
            throw new MembershipNotRetryable(`core answered HTTP ${answer.status}`)
          }
          throw error
        }
        return
      }
      const done = accept(internalAbandonOrganizationResponseSchema, answer)
      if (done.organizationId !== params.data.organizationId) {
        throw new MembershipUnavailable('core answered about another Organization')
      }
    },

    async forUser(userId, signal) {
      const request = internalMembershipRequestSchema.safeParse({ userId })
      if (!request.success) {
        throw new MembershipUnavailable('the request is not one the contract describes')
      }
      // A read has no effects, so a fresh key per lookup (the same one on its retry) is enough.
      const answer = await send(
        '/internal/membership',
        request.data,
        crypto.randomUUID(),
        { retry: true, timeoutMs: lookupTimeoutMs },
        signal
      )
      if (answer.status !== 200) {
        return refuse('membership', answer)
      }
      const found = accept(internalMembershipResponseSchema, answer)
      return found.found
        ? {
            organizationId: found.organizationId,
            role: found.role,
            organizationStatus: found.organizationStatus,
          }
        : null
    },
  }
}
