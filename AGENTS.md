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
`conformance/`), read only. Ticket 1.7 named commit `46d13ba`; the checkout it was ported from was
at `55e32edc` (46d13ba is an ancestor; the later commits touch proposals, the session admin
router, OAuth, the user service and migration 0035, none of which are in scope). Ported as-is
(rename of `TULA_MASTER_KEY` to `AUTH_MASTER_KEY` only): secret box, keyed hash, crypto and email
helpers, the password rule engine, lockout policy, flow-attempt, verification-code and refresh
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
  `createRouter()` and `errorResponse(...)`. `src/errors.ts` is this service's `area.reason`
  registry; throw `fail(AUTH_ERRORS['...'])`.
- Modules: `bootstrap` (the Region's one workspace, project and two environments, created under an
  advisory lock), `jwks` (keys, rotation, `/.well-known/jwks.json`), `token` (signs `at+jwt`),
  `flow` (sign-up and sign-in), `verification` (emailed codes), `password`, `membership` (the
  port to the core service, with a 5 s bound), `session` (create, refresh, sign-out, list,
  authenticate), `user` (`/v1/client/me`), `retention` (the purge, below), `conformance` (the
  scenario runner).
- Readiness checks `database` and `bootstrap`; shutdown as in the template (`src/shutdown.ts`).
- `openapi.json` is generated: `bun run openapi`; `verify` fails if it is stale.

## Routes

`GET /.well-known/jwks.json`, `GET /healthz`, `GET /readyz`, `GET /v1/client/password-policy`,
`POST /v1/client/sign-ups` (+ `/{id}/verify-email`, `/{id}/resend-code`),
`POST /v1/client/sign-ins` (+ `/{id}/password`), `POST /v1/client/sessions/refresh`,
`POST /v1/client/sessions/sign-out`, `GET /v1/client/sessions`, `GET /v1/client/me`. An attempt's
secret travels in `x-tula-attempt`; the client kind in `x-tula-client`.

## Accounts and Organizations

A user belongs to exactly one Organization. A sign-up carries exactly one of `organizationName`
(the user becomes Owner) or `invitationToken`; the account and its membership are made together,
so every token carries `org` and `role`. The membership port (`src/ports/membership.ts`) has
three operations: create an Organization for a new user, accept an invitation for a new user,
return the Organization and role of an existing user. The runtime adapter is a placeholder until
ticket 1.9 (it never invents a membership), so nobody can sign up on a real deployment yet.

Sign-up safety: the user id and the idempotency key `signup:<attempt id>` are fixed when the
attempt starts. The user rows are written inside a transaction whose last step is the membership
call; if core refuses, is down or exceeds 5 s the transaction rolls back (no account) and the
answer is `signup.*` (422) or `membership.unavailable` (503). The emailed code is spent only
after that, so a retry works. If the process dies after core made the Organization but before
the commit, the retry reuses the same key and core returns the same Organization.

Sign-in and refresh read the Organization (`forUser`) before any session or token exists. An
account with none gets `auth.no_organization` (403), is reported through `reportError`, and gets
no session and no token.

## Retention

Sign-in data is short-lived: an attempt lives 10
minutes and a code 10 minutes, and an abandoned sign-up holds an argon2id hash, the Organization
name and a sealed invitation, so they must not be kept. `modules/retention` deletes attempts (and,
by cascade, their codes) and then codes whose `expiresAt` has passed, `RETENTION_BATCH_SIZE` rows
per statement, repeating while a batch comes back full. It runs at boot (not awaited) and every
`RETENTION_INTERVAL_MS`, each run under a Postgres advisory lock (`ExclusiveRunner`, so only one
instance purges at a time and the others skip) and bounded by `RETENTION_RUN_TIMEOUT_MS`. A failed
or timed-out run is logged (no row data) and the next interval tries again. Shutdown stops it
before the pool closes. Sessions, refresh tokens and signing keys are not purged by this service
yet.

## Env keys (`src/env.ts`, mirrored in `.env.example`)

`ENVIRONMENT` (required), `REGION` (required: `us` or `eu`), `PORT`, `LOG_LEVEL`,
`READINESS_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`, `SHUTDOWN_GRACE_MS`, `MAX_REQUEST_BODY_BYTES`,
`DATABASE_URL`, `AUTH_MASTER_KEY` (64 hex, never logged) and `PUBLIC_URL` (all three required
outside `local`), `TOKEN_AUDIENCE` (default `closeline`), `DB_POOL_MAX` (default 10),
`RETENTION_INTERVAL_MS`, `RETENTION_BATCH_SIZE`, `RETENTION_RUN_TIMEOUT_MS`, `HASH_CONCURRENCY`,
`HASH_QUEUE`, `BREACH_CHECK_CONCURRENCY`, `BREACH_CHECK_QUEUE`. Add a key in both files.

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
  `tula-closeline-db` release (a separate ticket). Until then both maps are capped at 50,000 keys:
  expired keys go first, then the oldest key that is not locked or at its limit; a locked key is
  never evicted, and if every key is locked a new key is refused (fails closed).
- No mail provider: the runtime mailer fails with `mail.unavailable`. Tests use the memory mailer.
- No per-IP limit on sign-up and sign-in starts: it needs a trusted-proxy decision. What bounds
  the cost of a flood instead: a sign-up checks the password policy (local), then counts the send
  against the per-address cooldown and hourly cap, and only then makes the breach lookup and the
  argon2id hash, so an address over its cap costs neither (a password the breach list refuses
  does spend one send). Hashing and verification run in a concurrency limiter
  (`HASH_CONCURRENCY`, `HASH_QUEUE`) and the breach lookup in another
  (`BREACH_CHECK_CONCURRENCY`, `BREACH_CHECK_QUEUE`); when one is full and its queue too, the
  request is a 503 `server.unavailable` with `Retry-After` and is not reported to the error
  tracker. A sign-in start is still unthrottled per address (5 free password tries per
  identifier, and the dummy hash for an unknown one, are bounded only by the hash limiter).
- Key rotation has a service function (`Jwks.rotate`) but no route or schedule.

## Hot paths

The per-request middleware stack (`createBaseApp`), `/healthz`, and session refresh
(`Sessions.refresh`: each signed-in device calls it every minute). Refresh is O(1) in users,
sessions, Organizations and signing keys: one token lookup by hash, one user lookup by id, one
active-key read (`SigningKeyStore.active`, one row however many keys were retired), one
membership read to core, one signature, one rotation. The JWKS and bearer routes read at most 20
keys, bounded in SQL by retirement time and a limit. Budgets are in `bench/`.

A benchmark times `measure(operation)`: a warm-up, then several batches, gated on the fastest, so a
noisy runner cannot fail it but a real regression (every batch slower) does. Budget is about 5x the
typical best batch, written in the file. `bun run bench` is part of `verify`. Add a benchmark and
name the function here when a new hot path appears.

## Issues

All tickets live in the hub: `gh issue list -R Tula-Solutions/tula-closeline --label repo:auth`.
