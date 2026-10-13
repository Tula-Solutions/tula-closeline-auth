---
paths:
  - "src/adapters/http/**"
  - "src/adapters/placeholder/**"
  - "src/adapters/memory/membership*"
  - "src/ports/membership.ts"
  - "src/modules/membership/**"
  - "src/modules/session/refresh.ts"
  - "src/modules/flow/service.ts"
  - "src/testing/fake-core.ts"
---

# The token hook: membership from core

The runtime adapter is `src/adapters/http/membership.ts`, over HTTP to core's internal routes
(`POST /internal/organizations`, `/internal/invitations/accept`, `/internal/membership`) with
`Authorization: Bearer <CORE_INTERNAL_TOKEN>` and an `Idempotency-Key`. Every answer is parsed with the contract's
schema; one that does not parse is core being unavailable. Redirects are never followed, and the
secret, an invitation token, an address or a body of core never reach a log or an error message
(tests pin it). Accepting an invitation is not built in core yet, so that call fails (unavailable)
against a real core until it is. `local` with neither core setting runs on the placeholder
adapter (boots alone, nobody can sign up); outside `local` both settings are required and the
container refuses to build without them, so the placeholder cannot serve a deployment.

How core's answers map: `found: false` is no membership (`auth.no_organization`, reported);
`invitation.invalid` is `signup.invitation_invalid`; a name or token the contract's schema
forbids is refused locally as `signup.organization_name_invalid` / `signup.invitation_invalid`
without a call; 401 or 403 (a wrong shared secret, a deployment fault) is unavailable and is
reported with the class `CoreCredentialsRejected`; `membership.already_member` is unavailable too
(auth makes a fresh user id per attempt, so it means a fault, not something the person can fix);
anything else, a timeout, a 5xx or a body that does not parse is unavailable.

Status at token issuance (decided in `modules/membership/service.ts`, `Membership.of`):
`active` and `suspended` issue tokens (core itself refuses writes for a suspended Organization,
and its members must still read); `deleted` refuses sign-in and refresh with `organization.deleted`
(410), and a refresh also ends the session (`revoked_by_admin`); no membership is
`auth.no_organization` and is reported.

When core cannot answer (timeout, network error, 5xx, 401/403, bad body): sign-in and refresh
answer 503 `membership.unavailable` with `Retry-After: 5`, issue no token, create no session,
do not count against lockout (a right password clears it before core is asked), and rotate or
revoke nothing: the client retries the same attempt, or the same refresh token. Sign-up answers
the same 503; nothing is written and the attempt and its code stay usable. Bounds: the lookup is
one HTTP call of 2 s, retried once after 50 to 150 ms of jitter on a network error, a timeout or
a 5xx (worst case 4.15 s); the sign-up calls are tried once, 4.5 s (the flow retries the attempt
under the same key). The caller gives up on any call at 5 s and aborts its signal.
