# tula-closeline-auth

Closeline auth service: sign-up, sign-in, sessions and tokens, copied from tula-auth

Kind: **service**. Common standards for every Closeline repo are in `.claude/COMMON.md`, synced
from the hub (`tula-closeline`). This file holds only what is specific to this repo. Keep it under
200 lines: put detail in a path-scoped rule under `.claude/rules/` or a decision record in the hub.

## Commands

| Command | Use |
| --- | --- |
| `bun install` | install, including the tagged `tula-closeline-*` libraries |
| `bun run verify` | the full gate, exactly what CI runs |
| `bun run verify:changed` | the quick gate the Stop hook runs |
| `bun test` | tests |
| `bun run bench` | the benchmarks and their budgets |
| `bun run openapi` | rewrite `openapi.json` after a route or schema change |

Other scripts are in `package.json`.

## Where this came from

Ported from the source product `tula-auth-and-user-management` (`apps/api`, `packages/contract`,
`conformance/`), read only. Ticket 1.7 named commit `46d13ba`; it was ported from `55e32edc` (a
descendant; the later commits touch only out-of-scope areas). Ported as-is
(rename of `TULA_MASTER_KEY` to `AUTH_MASTER_KEY` only): secret box, keyed hash, crypto and email
helpers, the password rule engine (cut to the four rules the fixed policy runs, so each of its
codes is in the contract), lockout policy, flow-attempt, verification-code and refresh
logic. Adapted: ids and tenancy (`withEnvironment`, one fixed project), errors (the contract's
`area.reason` envelope), the sign-up (an Organization name or an invitation, see below).

Left out, and what the in-scope flows will miss: OAuth, passkeys, MFA, SMS, webhooks, hooks,
proposals, the admin API, native apps, API keys and the event outbox (so no `user.created` event
yet); password reset and change; email change; session profiles, stateful cookie sessions, device
binding and step-up (one hybrid session policy: access 60 s, idle 7 d, absolute 30 d); audit-log
and activity writes; per-environment settings (the policy is fixed: 10 to 128 characters,
common and breached passwords refused); resolving the environment by publishable key (the
service serves the one tenant it bootstrapped).

## Layout

The shape in `.claude/COMMON.md` is built; modules are under `src/modules/<name>/`.

- `src/container.ts` is the only composition root; `src/testing.ts` builds the same container from
  in-memory doubles (`createReadyDeps`), `src/testing/postgres-deps.ts` from the real Postgres
  adapters (integration tests).
- `reportError(error, context)` is the one seam for unexpected errors. It logs through the kit
  today. Call `reportSafely`, never it directly. 5xx errors reach it from the error handler; a
  4xx the deployment must fix (an account with no Organization) is reported by the flow.
- `src/http/` is the middleware stack in `createBaseApp`. Modules build routes with
  `createRouter()` and `errorResponses([...codes])`. Error codes are not defined here: every
  `area.reason` this service answers with is a key of `AUTH_ERRORS` (or the common `ERRORS`) in
  `tula-closeline-contract`; a new or changed code is a contract release first. Throw
  `fail(AUTH_ERRORS['...'])`; `src/errors.ts` holds only helpers, typed so `tsc` refuses any other
  definition, and `src/error-codes.test.ts` fails on any `area.reason` literal in shipped source
  that is not a key of a contract map. A route lists in its OpenAPI `responses` the codes its
  handler, services and middleware can produce (`BODY_ERRORS` for a route with a body); change
  the list with the code: `src/openapi-errors.test.ts` pins it.
- Modules: `bootstrap` (the Region's one workspace, project and two environments, created under an
  advisory lock), `jwks` (keys, rotation, `/.well-known/jwks.json`), `token` (signs `at+jwt`),
  `flow` (sign-up and sign-in), `verification` (emailed codes), `password`, `membership` (the
  port to the core service, with a 5 s bound and an abort signal), `session` (create, refresh,
  sign-out, list, authenticate), `user` (`/v1/client/me`), `retention` (the purge, below), `conformance` (the
  scenario runner).
- Readiness checks `database` and `bootstrap`; shutdown as in the template.
- `openapi.json` is generated: `bun run openapi`; `verify` fails if it is stale.

## Routes

`GET /.well-known/jwks.json`, `GET /healthz`, `GET /readyz`, `GET /v1/client/password-policy`,
`POST /v1/client/sign-ups` (+ `/{id}/verify-email`, `/{id}/resend-code`),
`POST /v1/client/sign-ins` (+ `/{id}/password`), `POST /v1/client/sessions/refresh`,
`POST /v1/client/sessions/sign-out`, `GET /v1/client/sessions`, `GET /v1/client/me`. An attempt's
secret travels in `x-tula-attempt`; the client kind in `x-tula-client`.

## Browser sessions (refresh cookie, hub issue 41)

`x-tula-client: browser` (stored as session client `web`) gets the refresh token in the cookie
`__Secure-tula_refresh` (HttpOnly, Secure, SameSite=Strict, `Path=/v1/client/sessions/`), never in
the body; refresh and sign-out read only the cookie, after an `Origin` allow-list check. Every
other client type is unchanged. Rules: `.claude/rules/session.md`. The known-device cookie is not
built here: it comes with the lockout change (hub issue 30), where its verification lives.

## Accounts and Organizations

A user belongs to exactly one Organization. A sign-up carries exactly one of `organizationName`
(the user becomes Owner) or `invitationToken`; the account and its membership are made together,
so every token carries `org` and `role`. `src/adapters/http/membership.ts` implements the membership
port over HTTP to core (`local` with no `CORE_*` setting runs a placeholder: nobody can sign up).
Answer mapping: `.claude/rules/membership.md`. Sign-in and refresh read the Organization first:
`active` and `suspended` get tokens, `deleted` `organization.deleted` (410; refresh also ends the
session), none `auth.no_organization` (403, reported). Core slow or down: sign-in,
refresh and sign-up answer 503 `membership.unavailable` (`Retry-After: 5`), issuing, counting,
rotating and spending nothing: retry the same attempt, code or token (a sign-up gives back the
verification try the code cost, so outages never use up a correct code). An outage is logged at
warn, one line per failed request, and not reported; a rejected secret is reported once a minute
per cause class (`src/http/errors.ts`). Core saying a new user already belongs to an Organization is a fault: 500,
no `Retry-After`, reported once per attempt, the try stays spent. Calls to core are capped
(`CORE_CONCURRENCY`, `CORE_QUEUE`); past the cap a call is 503 at once.

Sign-up safety: the user id and the idempotency key `signup:<attempt id>` are fixed when the
attempt starts, and `verify-email` holds no database transaction across the call to core. Order:
`findByEmail`, ask core, write the account in one short transaction; the emailed code is spent
only after the account exists, so a retry works and gets the same Organization. Details, and the
open ticket on reconciling Organizations whose account was never written: `.claude/rules/membership.md`.

## Retention

Sign-in data is short-lived (an attempt and a code live 10 minutes), and an abandoned sign-up
holds an argon2id hash, the Organization name and a sealed invitation, so they must not be kept.
`modules/retention` deletes attempts (and, by cascade, their codes) and then codes whose `expiresAt`
has passed, `RETENTION_BATCH_SIZE` rows per statement, repeating while a batch comes back full. It
runs at boot (not awaited) and every `RETENTION_INTERVAL_MS`, each run under a Postgres advisory
lock (`ExclusiveRunner`, so only one instance purges at a time and the others skip) and bounded by
`RETENTION_RUN_TIMEOUT_MS`. A failed or timed-out run is logged and reported to the error tracker
(no row data) and the next interval tries again. Only rows expired for more than 10 s (twice the
5 s bound on a call to core) are purged, so a sign-up that is waiting on core is never purged
before it spends its code. It needs 2 connections at once, so `DB_POOL_MAX` is at least 4.
Shutdown stops it before the pool closes. Sessions, refresh tokens and signing keys are not purged
by this service yet.

## Env keys (`src/env.ts`, mirrored in `.env.example`)

`ENVIRONMENT` (required), `REGION` (required: `us` or `eu`), `PORT`, `LOG_LEVEL`,
`READINESS_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_REQUEST_BODY_BYTES`,
`DATABASE_URL`, `AUTH_MASTER_KEY` (64 hex, never logged), `PUBLIC_URL`, `CORE_BASE_URL` (https)
and `CORE_INTERNAL_TOKEN` (32+ characters, never logged) (all five required outside `local`; in
`local` both core keys or neither), `CORE_CONCURRENCY` (default 64), `CORE_QUEUE` (default 256),
`TOKEN_AUDIENCE` (default `closeline`), `DB_POOL_MAX` (default 10, at least 4),
`RETENTION_INTERVAL_MS`, `RETENTION_BATCH_SIZE`, `RETENTION_RUN_TIMEOUT_MS`, `HASH_CONCURRENCY`,
`HASH_QUEUE`, `SIGN_IN_CONCURRENCY`, `SIGN_IN_QUEUE`, `BREACH_CHECK_CONCURRENCY`,
`BREACH_CHECK_QUEUE`, `MAIL_LOCAL_URL`, `MAIL_LOCAL_FROM` (local only), `SESSION_ALLOWED_ORIGINS` (exact origins,
comma-separated, https outside `local`, no wildcard; unset refuses every browser refresh and sign-out),
`SESSION_COOKIE_INSECURE` (`true` only in `local`: drops `Secure` and the prefix). Add a key in both files.

## Tests

`bun run verify` runs unit tests (memory adapters), the in-process conformance scenarios in
`conformance/scenarios/` (ported from the source, adapted to this service's error envelope and
sign-up, plus four of our own) and the benchmark. `docker compose up -d --wait` then
`bun run test:integration` runs the adapter suites, the concurrency tests and the same
scenarios against real Postgres as the `closeline_auth` role (`POSTGRES_PORT` moves the port).

## Known gaps

- **Deployment constraint: one instance until the counters move to Postgres.** Rate limits and
  lockout are per-process memory (`MemoryRateLimiter`, `MemoryLockout`), so with N instances an
  attacker gets N times the free guesses and sends, and every deploy or crash resets the counts.
  This breaks "state lives in Postgres, the queue or the cache"; moving them needs a table in a
  `tula-closeline-db` release (a separate ticket, hub issue 30). Until then both maps are capped
  at 50,000 keys. At the cap an insert looks at the front of the map only (64 keys, so it costs a
  bounded amount): the oldest key that is not locked or at its limit goes; a locked key is never
  evicted, and if the keys looked at are all locked a new key is refused (fails closed) and they
  move to the back: refusals of a new key are bounded by the locked keys divided by 64.
- **Known limitations of the per-process cap (go away with hub issue 30; pinned by tests named
  KNOWN LIMITATION).** Churn resets lockout: a key below its lockout is evicted after about
  50,000 newer keys, so 5 guesses per roughly 100,000 cheap requests is possible. Filling the cap
  with locked keys (5 tries each: about 1,000 requests a second for 20 minutes) refuses sign-in
  for new addresses. Sends are counted only after a hash slot is held and the cooldown lasts 60 s,
  so 50,000 buckets at their limit need about 830 admitted hashes a second, far above the hash
  lane's defaults. The edge limit (below) makes both expensive.
- **A stranger can lock a victim out of password sign-in.** Lockout is keyed by address and counted
  up front, so about 11 wrong tries on someone's address (then one every 15 minutes) keep their
  correct password refused (429 `rate.limited`) until the failures are forgotten after an hour of
  quiet. Inherited from the source design; `flow.test.ts` pins it as a known limitation. A
  follow-up ticket decides the redesign (e.g. key on address plus a device cookie, or exempt a
  known-good device).
- No production mail provider (hub issue #35): the mailer fails with `mail.unavailable`. Only in
  `local`, `MAIL_LOCAL_URL` selects a Mailpit mailbox adapter: `.claude/rules/mail.md`.
- **Deployment prerequisite: a per-source rate limit at the edge.** The service has no per-IP
  limit on sign-up and sign-in starts (it needs a trusted-proxy decision), so it must not be
  exposed to the internet until the edge (load balancer or WAF) limits requests per source;
  without one a single source can fill the limiters below and shed everyone else. Inside the
  service: a sign-up checks the password policy (local), takes a hash slot, and inside it counts
  the send against the per-address cooldown and hourly cap, and only then does the breach lookup
  and the argon2id hash, so an address over its cap costs neither (a password the breach list
  refuses does spend one send). Sign-up hashing (`HASH_CONCURRENCY`, `HASH_QUEUE`), sign-in
  verification (`SIGN_IN_CONCURRENCY`, `SIGN_IN_QUEUE`, a lane of its own) and the breach lookup
  (`BREACH_CHECK_CONCURRENCY`, `BREACH_CHECK_QUEUE`) each run in a concurrency limiter; when one
  and its queue are full the request is a 503 `server.unavailable` with `Retry-After`, not
  reported to the tracker. **A request that is shed is never counted against anyone:** sign-in
  counts the failed try, looks the user up and verifies inside the sign-in slot, and sign-up
  counts the send inside the hash slot, so a flood cannot lock accounts or burn send allowances.
  A password over 1,024 characters is refused as a wrong password (401
  `auth.invalid_credentials`) before anything is counted. A sign-in start is unthrottled per
  address (5 free tries per identifier, and the dummy hash, are bounded by the sign-in limiter).
- Key rotation has a service function (`Jwks.rotate`) but no route or schedule.

## Hot paths

The per-request middleware stack (`createBaseApp`), `/healthz`, and session refresh
(`Sessions.refresh`: each signed-in device calls it every minute). Refresh is O(1) in users,
sessions, Organizations and signing keys: one token lookup by hash, one user lookup by id, one
active-key read (`SigningKeyStore.active`, one row however many keys were retired), one
membership read to core (the token hook: one HTTP call, retried at most once, 4.15 s worst case,
asked once per request even if the rotation is retried; a replay inside the grace window asks
too, only a token spent beyond grace and an expired token cost no call),
one signature, one rotation. The membership lookup through the HTTP adapter is a hot path too
(`bench/membership.bench.test.ts`: best batch about 53 ms per 500 lookups, budget 270 ms). The
JWKS and bearer routes read at most 20 keys, bounded in SQL by retirement time and a limit.
The cookie variant adds only string work and has its own benchmark.
Budgets are in `bench/`.

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression does. Budget is about 5x the typical best batch,
written in the file. `bun run bench` is part of `verify`. Name a new hot path's benchmark here.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:auth`.
