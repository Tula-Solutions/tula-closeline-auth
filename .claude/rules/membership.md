---
paths:
  - "src/adapters/http/**"
  - "src/adapters/placeholder/**"
  - "src/adapters/memory/membership*"
  - "src/ports/membership.ts"
  - "src/modules/membership/**"
  - "src/modules/abandon/**"
  - "src/ports/abandon-cases.ts"
  - "src/adapters/postgres/abandon-cases.ts"
  - "src/adapters/memory/abandon-cases.ts"
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
(`POST /internal/organizations`, `/internal/invitations/accept`, `/internal/membership`,
`/internal/organizations/{id}/abandon`) with
`Authorization: Bearer <CORE_INTERNAL_TOKEN>` and an `Idempotency-Key`. Every answer is parsed with the contract's
schema; one that does not parse is core being unavailable. The transport is the kit's
`createInternalClient` (ADR 0013): `node:http(s)` with no agent, so a proxy variable in the
environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, any case) is never read and the secret never
travels through a proxy; a new connection per call, certificates verified, and the service refuses
to boot with `NODE_TLS_REJECT_UNAUTHORIZED=0` outside `local`. The adapter is the only place the
client is built (`environment` is an option, passed by `container.ts`). Do not use `fetch` for a
call to core; `membership.proxy.test.ts` (a child process with a stand-in proxy named in all six
variables) fails if a call reaches the proxy. Redirects are never followed, and the
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

**Retries live in one layer: this adapter** (and the abandon loop in `modules/membership`). The
kit client is built with `retry: { maxAttempts: 1 }`, because its own rules differ (it retries only
429, 502, 503, 504 and not a plain 500) and a second layer would multiply attempts and break the
time bounds below. `membership.attempts.test.ts` pins the attempts of a failing call: lookup 2,
create 1, accept 1, abandon 1 (the abandon loop adds its own three).

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

## What core is told about the person, and orphaned Organizations

Both sign-up calls send core a copy for its member list (hub ADR 0015, ticket 31):
`email` is the verified address as normalized (`attempt.identifier`: trimmed, ASCII letters
folded; the form core's checks fold to), `name` is `composeMemberName(firstName, lastName)`
(`modules/membership/profile.ts`): the two optional parts trimmed and joined by one space, `null`
when nothing remains. Auth's own limits (100 characters per part, 201 with the space) equal the
contract's `personNameSchema` maximum, but auth allows control characters that the contract
refuses, so each run of them becomes one space and the result is checked against the schema; a
name that still failed would be sent as `null`, never fail the sign-up at core.

**An Owner's Organization is abandoned in the request in exactly one case (ticket 36).** In
`verifyEmail`, `users.create` returned `false` (a unique violation), the account read by this user
id is absent, and a read of the address shows a holder whose id is a different user's
(`src/modules/flow/service.ts`, the `settleOrphan(deps, context, 409, ...)` call). That proves this
attempt's account can never be written: the address is another user's. "This user id already has
an account with this address" is this attempt's own earlier request and is never an orphan
(sign-up completes). Then the flow calls `Membership.abandon` (port `abandonOrganization`;
`POST /internal/organizations/{id}/abandon`, body `{userId}`, key `abandon:<attempt id>`):

- Up to three tries, a jittered doubling pause of 50 to 150 ms and then 100 to 300 ms (at least
  core's `Retry-After`, at most 1 s: the adapter passes the kit's `retryAfterMs` on in `MembershipBusy`). The 5 s bound is for the whole abandon (all tries and
  pauses), and each try is one HTTP call of at most 4.5 s. The sign-up answer never changes.
  Worst case a failed sign-up waits for its call to core (5 s) plus this abandon (5 s): 10 s.
- 200 is done (core says no live Organization with that id remains; not that this call deleted
  it): logged at warn by ids, not reported. 409 `organization.not_abandonable` is logged by ids
  at warn, never retried, reported. 5xx, 503 (paced by core's `Retry-After`, capped at 1 s), a timeout or a
  network error are retried; a 4xx other than that 409 is one call (`MembershipNotRetryable`), as is a rejected
  secret. An unfinished abandon is logged and reported by ids.
- A sign-up by invitation is never abandoned: the Organization has other members.

**An unexpected error from the insert is never abandoned in the request.** It is reported by ids.
Nothing in this process can prove the account will never be written while the attempt is usable: a
double submit of one attempt (request A's insert throws while B, same user id, commits afterwards)
or a commit that outlived a dropped connection would make an abandon delete a working Owner's
Organization, because core's guard passes for the real Owner as sole member (a test pins the
double submit). That abandon belongs to the sweep (below). Core frees the user id on abandon and creates
idempotently on the user id, so a client retrying one attempt after an abandon gets a fresh
Organization.

## The abandon case and the sweep (hub issue 36, db `0.8.0`)

**Recording.** An Owner sign-up (never an invitation) writes a case in `auth.abandon_cases`
before core is asked, in its own committed transaction: case id = attempt id, user id, attempt
expiry, Organization id unknown, grace `ABANDON_GRACE_MS` (5 s call bound + 25 s skew margin; the
table's floor is 10 s). If recording fails the request fails with nothing created at core. After
core answers, `learn` fills the Organization id (best effort; a failure leaves it for the sweep to
find; a unique violation resolves the case `gave_up` in a new transaction and reports both ids).
`users.create` runs `ABANDON_RESOLVE` (`done`) in the same transaction as the account, so a
committed account never leaves an open case. Added per Owner sign-up: 3 statements (record,
learn, and the resolve inside the account transaction), 2 extra short transactions. The db has no
"not needed" outcome: `done` means the case is finished and nothing is owed (also used when the
account exists or core holds no Organization); `refused` and `gave_up` are the two a person must
look at. Residual: a retry of an attempt whose case was already resolved finds the record
silently refused (`on conflict do nothing`); the holder check in `verifyEmail` stops it unless the
other holder is deleted.

**The sweep** (`modules/abandon`, `start` in `server.ts`, every `ABANDON_SWEEP_INTERVAL_MS`) has
its own advisory lock `abandon-sweep`, not retention's: it calls core (seconds per case) while the
purge must stay quick, and a slow core must never hold either back. It claims `ABANDON_SWEEP_BATCH_SIZE`
cases as a lease (`leaseMs` = batch x 11 s + 25 s, longer than the whole batch worked one after
another), calls core outside any transaction, then resolves in a new one; repeats while a claim
is full; runs `giveUpSpent` once per run after the first claim. A case is due only after the
attempt's expiry plus grace by the database clock. For each claimed case: past
`ABANDON_SWEEP_MAX_ATTEMPTS` (40) claims it is resolved `gave_up` and reported; an account for
the user id exists means resolve `done`, no call; an unlearned case is looked up by user id with
the membership lookup (the one call that finds an Organization by user: none means core made
nothing, resolve `done`; a lookup failure leaves the case); then `Membership.abandon` with
key `abandon:<attempt id>`: 200 resolve `done`, 409 resolve `refused` and report (once: only the
run whose resolve returned a row reports), 503 or network failure leaves the case for its next
lease. A resolve that returns no row (lost lease) is not an error. Ids only in logs and reports.

**Why abandoning is safe.** The account check and the call to core are not atomic. The ordering
argument: a case is claimed only after expiry + grace (the table's `abandon_cases_due_after_expiry`
check keeps it so); a request that loaded the attempt before expiry holds it for at most the 5 s
call plus a few statements, so none can commit an account for this attempt after that point, and
a read that found none stays true. Core's own guard (sole member is the user, under 24 hours, not
suspended) is the second line. Do not shorten the grace below the call bound; do not add a path
that writes an account for an expired attempt. Tests that move the fixed clock must back-date
rows in Postgres (the database clock decides): see `abandon.integration.ts`.

**Still open:** the in-request abandon of the narrow unique-violation case resolves its case
(`done` or `refused`, `unfinished` stays open). An error inside the account transaction is only
reported and left to the sweep.
