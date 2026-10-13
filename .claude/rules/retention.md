---
paths:
  - "src/modules/retention/**"
---

# Retention

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
Each run then purges expired lockout and rate-limit counters (`rules/lockout.md`). The purge also deletes abandon cases resolved a day ago (`ABANDON_PURGE_BATCH`). The abandon sweep is a separate schedule with its own lock (`rules/membership.md`); with retention it can hold up to 4 connections, so `DB_POOL_MAX` stays at least 4 and requests may wait briefly at that size. Shutdown stops both before the pool closes. Sessions, refresh tokens and signing keys are not purged
by this service yet.
