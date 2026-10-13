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
  - "src/errors.ts"
  - "src/http/errors.ts"
  - "src/lib/throttle.ts"
  - "src/lib/concurrency.ts"
  - "src/modules/verification/**"
  - "bench/membership.bench.test.ts"
---

# The token hook: membership from core

The runtime adapter is `src/adapters/http/membership.ts`, over HTTP to core's internal routes
(`POST /internal/organizations`, `/internal/invitations/accept`, `/internal/membership`) with
`Authorization: Bearer <CORE_INTERNAL_TOKEN>` and an `Idempotency-Key`. Every answer is parsed with the contract's
schema; one that does not parse is core being unavailable. Redirects are never followed, and the
secret, an invitation token, an address or a body of core never reach a log or an error message
(tests pin it). Core's accept route is on its `develop` (checked against
`src/modules/internal/router.ts` and `service.ts` there): a retry by the same user and address
answers 200 as the first call did, whatever the key. `local` with neither core setting runs on
the placeholder adapter (boots alone, nobody can sign up); outside `local` both settings are required and the
container refuses to build without them, so the placeholder cannot serve a deployment.

How core's answers map: `found: false` is no membership (`auth.no_organization`, reported);
`invitation.invalid` is `signup.invitation_invalid`; a name or token the contract's schema
forbids is refused locally as `signup.organization_name_invalid` / `signup.invitation_invalid`
without a call; 401 or 403 (a wrong shared secret, a deployment fault) is unavailable and is
reported with the class `CoreCredentialsRejected` (see below for how often); `membership.already_member`
(from a create or an accept) is a `MembershipFault`, not an outage: auth makes a fresh user id per
attempt, so it means a fault on one side that retrying cannot clear. A lookup is never allowed that
code. Anything else, a
timeout, a 5xx or a body that does not parse is unavailable.

Status at token issuance (decided in `modules/membership/service.ts`, `Membership.of`):
`active` and `suspended` issue tokens (core itself refuses writes for a suspended Organization,
and its members must still read); `deleted` refuses sign-in and refresh with `organization.deleted`
(410), and a refresh also ends the session (`revoked_by_admin`); no membership is
`auth.no_organization` and is reported.

When core cannot answer (timeout, network error, 5xx, 401/403, bad body): sign-in and refresh
answer 503 `membership.unavailable` with `Retry-After: 5`, issue no token, create no session,
do not count against lockout (a right password clears it before core is asked), and rotate or
revoke nothing: the client retries the same attempt, or the same refresh token. Sign-up answers
the same 503; nothing is written and the attempt and its code stay usable: `verifyCode` counts a
try before it compares, so when the code matched and `join` then fails as unavailable the flow
gives that try back (`VerificationTokenStore.refundAttempt`, one guarded UPDATE that only lowers a
counter above zero on an unused token, so tries left never exceed the maximum). A wrong code is
never given back, and a `MembershipFault` keeps its try spent, so a fault that never clears runs
the code out instead of looping.

Bounds: the lookup is one HTTP call of 2 s, retried once after 50 to 150 ms of jitter on a
network error, a timeout or a 5xx (worst case 4.15 s); the sign-up calls are tried once, 4.5 s (the flow retries the attempt
under the same key). The caller gives up on any call at 5 s and aborts its signal.

## What is reported, and how often

- An outage (`MembershipOutage`, 503 `membership.unavailable`, `Retry-After: 5`) is an
  `Unreported` error: the handler logs it at warn (`membership is unavailable`, with the cause
  class and request id) and does not report it, exactly as the overloaded path behaves. One outage
  would otherwise report once per sign-in, refresh and sign-up, from every device.
- A rejected shared secret (401 or 403 from core, `MembershipRejected`) is always logged and is
  reported at most once a minute per cause class (`CoreCredentialsRejected`), through a small
  bounded in-process throttle (`src/lib/throttle.ts`, 32 keys). It is best-effort state: it resets
  on restart and each instance has its own, so a fleet reports a few times a minute at worst.
- A `MembershipFault` becomes `MembershipFaulted` (500 `server.internal`, no `Retry-After`). The
  sign-up flow reports it once per attempt per hour, ids only (`reportMembershipFault`), and
  the handler does not report it again.

## Refresh and core

`Sessions.refresh` decides everything that needs no answer from core first (an ended session, a
banned user, a token spent beyond the grace window or without a usable next token, an expired
token), so a token spent beyond grace and an expired token cost no call and an outage cannot
defer reuse detection. A replay inside the grace window does ask core: it is handed the same next
token with a fresh access token. Core is asked at most once per request: if the rotation loses a
race and runs again, the answer is reused. The clock is read again after the answer, for the
access token's issue time and the rotation time that starts the grace window. Because core may
take seconds, what was decided before the call is decided again after it: a replay re-reads the
session, user and next token (ended, revoked, banned or expired, or the next token already
spent, is refused as the rotation path would), and a rotation refuses with `session.expired`
when the session's or the token's expiry has passed by the new time.

Two tolerances are accepted. The rotation path does not read the user's ban again after the call
to core, so a user banned during the call (at most 5 s) gets one more rotation and one access
token (60 s at most), and the next refresh refuses; the replay path does read it again (a test
pins this). And a client that retries a slow refresh, then uses the late first response while the
retry is still waiting on core, is signed out as reuse: the same outcome the check before the
call gives when the two requests arrive in the other order.

## Calls to core are capped

The adapter runs at most `CORE_CONCURRENCY` (default 64) requests at once, with `CORE_QUEUE`
(default 256) more waiting for a slot. Past that a call fails at once, unsent, as
`CoreSaturated` (unavailable, never retried). The cap covers one request, not the lookup's pause
before its retry, and a caller that gave up while waiting sends nothing when its turn comes. The
benchmark is `bench/membership.bench.test.ts` (an in-process fake of core; budget in the file).

## Sign-up order and orphans

Sign-up safety: the user id and the idempotency key `signup:<attempt id>` are fixed when the
attempt starts. `verify-email` holds no database transaction across the call to core (a slow core
would starve the pool and take sign-in, refresh and `/readyz` down with it). Order: check the
address is free (`findByEmail`), ask core with the key and the user id, then write the account in
one short transaction. If core refuses, is down or exceeds the 5 s bound (the call's `AbortSignal`
aborts at the bound, so an adapter cancels the request), nothing was written and the answer is
`signup.*` (422) or `membership.unavailable` (503); the emailed code is spent only after the
account exists, so a retry works, and a retry (even after a crash) gets the same Organization
from core. An insert that finds the same user id already there is such a retry and counts as done.
After the commit, spending the code and closing the attempt are best-effort (logged with the
attempt id, never fatal); a failure creating the first session is an error but the account
exists, and signing in recovers it.

**Orphaned Organizations still need reconciliation (open, a follow-up ticket).** Core can create
an Organization for a sign-up whose account is never written: the insert loses the address to
another sign-up (409 `flow.invalid_step`), the insert fails for another reason (500), the process
dies between core and the insert, or the attempt expires before a retry (a new attempt has a new
key, so a second Organization). The first two are reported through `reportError` with the
Organization, user and attempt ids and no address, once per attempt per hour. An orphan is always
logged with ids, even when the report is suppressed or the limiter map is full. A burned
invitation is the same. A timed-out call is not reported with an Organization id (none is
known); a retry with the same key converges. Auth does not clean these up; a reconciliation job
must find Organizations whose owner never signed in, which needs a call in core that does not
exist yet.
