---
paths:
  - "src/modules/flow/**"
  - "src/ports/lockout.ts"
  - "src/ports/rate-limiter.ts"
  - "src/ports/counter-purger.ts"
  - "src/adapters/postgres/counters*"
  - "src/modules/retention/**"
---

# Lockout, rate limits and the known-device cookie (hub issue 30, ADR 0014)

## Where the counters live

`auth.attempt_counters` (db 0.8.0), one table for the `Lockout` and `RateLimiter` ports, shared by
every instance; no state in process memory outside tests (the memory adapters stay for unit tests
and `createTestDeps`). `adapters/postgres/counters.ts` runs the db library's statements
(`LOCKOUT_ATTEMPT`, `LOCKOUT_RETRY_AFTER`, `LOCKOUT_CLEAR`, `RATE_HIT`, `COUNTER_PURGE_BATCH`) on the
pool with an explicit environment id; the container builds them (and nowhere else). The database
clock decides: the `now` the port passes is ignored, and the service sends the wait schedule (an
array built from `lockoutDelayMs`) and the forgetting period, never a time. A refused attempt
returns no row; the retry time is a second read; no row or 0 there re-runs the attempt once, then
answers locked with at least `LOCKOUT_MIN_RETRY_AFTER_MS`. A database error propagates (500): an
attempt is never allowed uncounted. Tests move time by back-dating rows, never by sleeping.

## The key

The row key is `HMAC-SHA-256(COUNTER_HASH_KEY, port key)`, 32 bytes. The port key already holds a
SHA-256 of the normalised address (`signInLockKey`, `enforceSendLimits`), never the address, and
the table never sees it either. **Rotating `COUNTER_HASH_KEY`** makes every existing counter
unreachable: they are orphaned, expire, and the purge removes them, and every address's guessing
budget restarts once. Rotate `DEVICE_COOKIE_KEY` and every known-device cookie stops verifying: all
devices are unknown until their next sign-in. Neither key, no hash and no address is ever logged.
In `local` fixed development keys are used (`LOCAL_COUNTER_HASH_KEY`, `LOCAL_DEVICE_COOKIE_KEY`).

## Schedule (unchanged)

`CREDENTIAL_LOCKOUT`: 5 free tries, the 6th starts a 30 s wait, then 60 s doubling to 15 minutes
(the 11th wrong password and every later one), forgotten after an hour of quiet.

## Known devices

- **Cookie** (`modules/flow/device-cookie.ts`): `__Secure-tula_known_device` (`tula_known_device`
  with `SESSION_COOKIE_INSECURE=true`, local only), `Path=/v1/client/sign-ins` (the start and the
  password routes, no other), `Max-Age` 90 days, `HttpOnly`, `Secure`, `SameSite=Strict`, host-only.
  A separate cookie from the refresh cookie. Value
  `v1.<user uuid>.<device id>.<expiry seconds>.<signature>`; the signature is HMAC-SHA-256 under
  `DEVICE_COOKIE_KEY` over the first four fields, compared in constant time. The device id is 16
  random bytes. It is set on every successful sign-in of a `browser` client (renewing the 90 days,
  keeping the device id the browser already had for that account, otherwise a new one) and never
  on a failure, a sign-up or another client type; it is a header only, never in the body.
- **Verification.** A missing, malformed, tampered, expired or wrong-account cookie is exactly no
  cookie: no error, the same refusal, and a value of the right shape costs the same signature check
  as a forged one. Whether it is for this account is decided only after the address is found
  locked, by looking the address up (a request with no valid cookie does no lookup it did not
  already do).
- **Effect.** When the address is locked, a request refuses unless its cookie is valid and for the
  account that address belongs to. Nothing in a response says whether an address has an account or
  whether a cookie was accepted, except to the holder of a good cookie, who signs in.
- **Bound.** A known device's wrong passwords count against its own counter, key
  `known_device:<environment>:<user uuid>:<device id>`, policy `KNOWN_DEVICE_LOCKOUT` (same shape as
  the address: 5 free, then 30 s doubling to 15 minutes, forgotten after an hour). It is checked
  whether or not the address is locked. A copied cookie therefore gets about the guesses of an
  unknown device, on top of the address, and no more.
- **What a success clears.** The device counter always. The address counter only if the address was
  not locked: a known device getting in does not end a lock other people earned (an attacker
  cannot make a known-device success, and clearing would give guessers a fresh budget each time the
  owner signs in).

## Cost

Sign-in password step, added database round trips (it counted in memory before): 1 for the address
counter, +1 read when the address is refused, +1 when that read races; +2 for a known device (its
counter, and its clear); +1 to clear on success; a locked address with a cookie also does the
user lookup the unlocked path does. Sign-up sends: 2 (cooldown and hourly counters) per send. All
are single-row statements on the primary key. Sign-in is not a named hot path; refresh does not
touch counters.

## Purge

`modules/retention` (the existing interval run under the advisory lock) also runs
`CounterPurger.deleteExpired` (`COUNTER_PURGE_BATCH`, across environments, rows expired over a
minute) in batches of `RETENTION_BATCH_SIZE`, repeating while a batch is full. It needs no process
memory and many instances run it safely (the lock, and `skip locked` in the statement).
