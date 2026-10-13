import {
  ABANDON_MAX_AGE_HOURS,
  CORE_ERRORS,
  type CoreErrorCode,
  ERRORS,
  foldAscii,
  formatId,
  type InvitableRole,
  idempotencyKeySchema,
  internalAbandonOrganizationParamsSchema,
  internalAbandonOrganizationRequestSchema,
  internalAcceptInvitationRequestSchema,
  internalCreateOrganizationRequestSchema,
  internalMembershipRequestSchema,
  type OrganizationId,
  type OrganizationStatus,
  type Role,
  type UserId,
} from 'tula-closeline-contract'

/** One request the fake received. Headers are lower-cased. */
export type RecordedRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

/** A canned answer for the next request (instead of the fake's own logic). */
export type Reply =
  | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'hang' }

/** A stand-in for the core service's internal routes, on an ephemeral local port. */
export type FakeCore = {
  /** The origin to configure as `CORE_BASE_URL`. */
  url: string
  /** The shared secret it accepts. */
  secret: string
  /** Every request received, in order. */
  requests: RecordedRequest[]
  /** An Invitation that accept calls honour for this (folded) address. */
  invite: (token: string, invitation: { email: string; role?: InvitableRole }) => void
  /** Set an Organization's status, which the lookups of its members report. */
  setStatus: (organizationId: string, status: OrganizationStatus) => void
  /** Answer every request 503 (`true`) or normally again (`false`). */
  breakDown: (broken: boolean) => void
  /** The answers for the next requests, one each, then back to normal. */
  script: (...replies: Reply[]) => void
  /** Drops the scripted answers not yet used. */
  clearScript: () => void
  /** Resolves once at least `count` requests have arrived. */
  untilRequests: (count: number) => Promise<void>
  /** Resolves once at least `count` requests were abandoned by their client. */
  untilAbandoned: (count: number) => Promise<void>
  /** Moves the fake's own clock forward, which the 24 hour abandon rule reads. */
  advanceClock: (ms: number) => void
  /** Stops the server. */
  stop: () => Promise<void>
}

/** The error body core sends for a registry entry. */
function coreError(code: CoreErrorCode | 'auth.unauthenticated' | 'request.invalid') {
  const definition =
    code === 'auth.unauthenticated' || code === 'request.invalid' ? ERRORS[code] : CORE_ERRORS[code]
  return Response.json(
    { error: { code: definition.code, message: definition.message } },
    { status: definition.status }
  )
}

/** A counter whose waiters resolve when it reaches their target. */
function counter() {
  let value = 0
  const waiters: { target: number; resolve: () => void }[] = []
  return {
    bump() {
      value += 1
      for (const waiter of waiters) {
        if (value >= waiter.target) {
          waiter.resolve()
        }
      }
    },
    until(target: number): Promise<void> {
      return value >= target
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ target, resolve }))
    },
  }
}

/**
 * Starts a fake of core's internal routes that follows the contract: it checks the bearer secret,
 * the idempotency header and each strict request schema, answers with the contract's shapes, and
 * keeps the one-Organization-per-user rule. Tests arrange it with `invite`, `setStatus`,
 * `breakDown` and `script`, and read what it received from `requests`.
 */
export function startFakeCore(secret = 'fake-core-secret-0123456789abcdef-0123'): FakeCore {
  const requests: RecordedRequest[] = []
  const arrived = counter()
  const abandoned = counter()
  const scripted: Reply[] = []
  const statuses = new Map<string, OrganizationStatus>()
  const members = new Map<string, { organizationId: OrganizationId; role: Role }>()
  const invitations = new Map<
    string,
    { email: string; role: InvitableRole; organizationId: OrganizationId }
  >()
  const created = new Map<string, number>()
  let skewMs = 0
  const acceptedByKey = new Map<string, { organizationId: OrganizationId; role: Role }>()
  let broken = false

  const handle = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    const text = await request.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    requests.push({
      method: request.method,
      path,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    arrived.bump()
    request.signal.addEventListener('abort', () => abandoned.bump(), { once: true })

    const next = scripted.shift()
    if (next) {
      switch (next.kind) {
        case 'hang':
          return new Promise<Response>(() => {})
        case 'json':
          return Response.json(next.body, { status: next.status, headers: next.headers })
        case 'text':
          return new Response(next.body, { status: next.status })
        case 'redirect':
          return new Response(null, { status: next.status, headers: { location: next.location } })
      }
    }
    if (broken) {
      return new Response('upstream is down', { status: 503 })
    }
    if (request.headers.get('authorization') !== `Bearer ${secret}`) {
      return coreError('auth.unauthenticated')
    }
    const key = request.headers.get('idempotency-key') ?? ''
    if (request.method !== 'POST' || !idempotencyKeySchema.safeParse(key).success) {
      return coreError('request.invalid')
    }

    if (path === '/internal/organizations') {
      const parsed = internalCreateOrganizationRequestSchema.safeParse(body)
      // Like core: the contract leaves `email` optional, but a Membership cannot exist without one.
      if (!parsed.success || parsed.data.email === undefined) {
        return coreError('request.invalid')
      }
      const existing = members.get(parsed.data.userId)
      if (existing) {
        return existing.role === 'owner'
          ? Response.json(existing)
          : coreError('membership.already_member')
      }
      const membership = {
        organizationId: formatId('org', crypto.randomUUID()),
        role: 'owner' as const,
      }
      members.set(parsed.data.userId, membership)
      created.set(membership.organizationId, Date.now() + skewMs)
      return Response.json(membership)
    }

    if (path === '/internal/invitations/accept') {
      const parsed = internalAcceptInvitationRequestSchema.safeParse(body)
      if (!parsed.success) {
        return coreError('request.invalid')
      }
      const earlier = acceptedByKey.get(key)
      if (earlier) {
        return Response.json(earlier)
      }
      const invitation = invitations.get(parsed.data.invitationToken)
      if (!invitation || invitation.email !== foldAscii(parsed.data.email)) {
        return coreError('invitation.invalid')
      }
      if (members.has(parsed.data.userId)) {
        return coreError('membership.already_member')
      }
      invitations.delete(parsed.data.invitationToken)
      const membership = { organizationId: invitation.organizationId, role: invitation.role }
      members.set(parsed.data.userId, membership)
      acceptedByKey.set(key, membership)
      return Response.json(membership)
    }

    if (path === '/internal/membership') {
      const parsed = internalMembershipRequestSchema.safeParse(body)
      if (!parsed.success) {
        return coreError('request.invalid')
      }
      const member = members.get(parsed.data.userId as UserId)
      return Response.json(
        member
          ? {
              found: true,
              ...member,
              organizationStatus: statuses.get(member.organizationId) ?? 'active',
            }
          : { found: false }
      )
    }
    const abandonPath = /^\/internal\/organizations\/([^/]+)\/abandon$/.exec(path)
    if (abandonPath) {
      const params = internalAbandonOrganizationParamsSchema.safeParse({
        organizationId: abandonPath[1],
      })
      const parsed = internalAbandonOrganizationRequestSchema.safeParse(body)
      if (!(params.success && parsed.success)) {
        return coreError('request.invalid')
      }
      const { organizationId } = params.data
      const here = [...members.entries()].filter(([, m]) => m.organizationId === organizationId)
      const status = statuses.get(organizationId) ?? 'active'
      if (here.length > 0 && status !== 'deleted') {
        // Like core: one member, that user, and an Organization that is not suspended.
        const born = created.get(organizationId)
        const old =
          born !== undefined && Date.now() + skewMs - born >= ABANDON_MAX_AGE_HOURS * 3_600_000
        if (
          here.length !== 1 ||
          here[0]?.[0] !== parsed.data.userId ||
          status === 'suspended' ||
          old
        ) {
          return coreError('organization.not_abandonable')
        }
        members.delete(parsed.data.userId)
        statuses.set(organizationId, 'deleted')
      }
      return Response.json({ organizationId, status: 'deleted' })
    }
    return Response.json(
      { error: { code: 'request.not_found', message: 'No such route.' } },
      { status: 404 }
    )
  }

  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
  return {
    url: `http://127.0.0.1:${server.port}`,
    secret,
    requests,
    invite: (token, invitation) =>
      void invitations.set(token, {
        email: foldAscii(invitation.email),
        role: invitation.role ?? 'rep',
        organizationId: formatId('org', crypto.randomUUID()),
      }),
    setStatus: (organizationId, status) => void statuses.set(organizationId, status),
    breakDown: (value) => {
      broken = value
    },
    script: (...replies) => void scripted.push(...replies),
    clearScript: () => void scripted.splice(0),
    untilRequests: (count) => arrived.until(count),
    untilAbandoned: (count) => abandoned.until(count),
    advanceClock: (ms) => {
      skewMs += ms
    },
    stop: async () => {
      await server.stop(true)
    },
  }
}
