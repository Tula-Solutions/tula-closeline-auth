import {
  CORE_ERRORS,
  type CoreErrorCode,
  emailSchema,
  errorBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  INTERNAL_CALL_ERRORS,
  type InternalCallName,
  idempotencyKeySchema,
  internalAcceptInvitationRequestSchema,
  internalAcceptInvitationResponseSchema,
  internalCreateOrganizationRequestSchema,
  internalCreateOrganizationResponseSchema,
  internalMembershipRequestSchema,
  internalMembershipResponseSchema,
  invitationTokenSchema,
  organizationNameSchema,
} from 'tula-closeline-contract'
import type { Logger } from 'tula-closeline-kit'
import type { z } from 'zod'
import { createConcurrencyLimiter, Saturated } from '~/lib/concurrency'
import {
  type Membership,
  type MembershipClaims,
  MembershipFault,
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
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
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

/** What an exchange with core produced: the status and the JSON body when it had one. */
type Answer = { status: number; json: unknown }

/** Reads at most {@link MAX_ANSWER_BYTES} of a body; a longer one is refused, not truncated. */
async function readBounded(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return text + decoder.decode()
    }
    bytes += value.byteLength
    if (bytes > MAX_ANSWER_BYTES) {
      await reader.cancel()
      return undefined
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** Parses JSON, or `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

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
 * No message or log line made here contains the secret, a token, an address or a response body.
 */
export function createHttpMembership(options: HttpMembershipOptions): MembershipClaims {
  const base = options.baseUrl.replace(/\/+$/, '')
  const authorization = `Bearer ${options.token}`
  const doFetch = options.fetch ?? globalThis.fetch
  const lookupTimeoutMs = options.lookupTimeoutMs ?? LOOKUP_ATTEMPT_TIMEOUT_MS
  const writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs

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
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'closeline-auth',
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal,
      })
      // Only an answer that can be used is read: a 5xx, a redirect or an odd status is not.
      const readable = response.status === 200 || (response.status >= 400 && response.status < 500)
      if (!readable) {
        await response.body?.cancel()
        return { status: response.status, json: undefined }
      }
      const text = await readBounded(response)
      return { status: response.status, json: text === undefined ? undefined : parseJson(text) }
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new AttemptFailed('the call was aborted', false)
      }
      if (timeout.aborted) {
        throw new AttemptFailed('core did not answer in time', true)
      }
      // The name only: a network error's message can quote the address it tried.
      const kind = error instanceof Error ? error.name : 'unknown'
      throw new AttemptFailed(`core could not be reached (${kind})`, true)
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
      // Auth makes a fresh user id for every sign-up attempt, so core saying the user already
      // belongs to an Organization is a fault on one side: retrying cannot clear it and the
      // person cannot fix it, so it is not the outage that `membership.unavailable` means.
      throw new MembershipFault('core says the user already belongs to an Organization')
    }
    throw new MembershipUnavailable(`core answered HTTP ${answer.status}`)
  }

  return {
    async createOrganization({ userId, name, idempotencyKey, signal }): Promise<Membership> {
      if (!organizationNameSchema.safeParse(name).success) {
        throw new MembershipRefused('organization_name_invalid')
      }
      const request = internalCreateOrganizationRequestSchema.safeParse({
        userId,
        organizationName: name,
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
