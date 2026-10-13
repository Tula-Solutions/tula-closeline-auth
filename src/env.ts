import { regionSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The most grace plus drain may add up to, so an orchestrator's kill window is not outlasted. */
const MAX_SHUTDOWN_TOTAL_MS = 60_000

/**
 * The three spellings of a local mailbox's origin, with an optional port (1 to 65535, no leading
 * zero) and an optional single trailing slash. Matched on the raw value, so no other spelling of
 * the same address (`127.1`, `2130706433`, `127.0.0.1.`, a full-width name, spaces) is accepted.
 */
const LOCAL_MAILBOX =
  /^http:\/\/(127\.0\.0\.1|\[::1\]|[lL][oO][cC][aA][lL][hH][oO][sS][tT])(?::([1-9]\d{0,4}))?\/?$/

/** The canonical origin of a local mailbox (lower-case, no trailing slash), or `undefined`. */
function localMailboxOrigin(value: string): string | undefined {
  const match = LOCAL_MAILBOX.exec(value)
  if (match === null) {
    return undefined
  }
  const port = match[2]
  if (port !== undefined && Number(port) > 65535) {
    return undefined
  }
  return `http://${(match[1] ?? '').toLowerCase()}${port === undefined ? '' : `:${port}`}`
}

/** The most origins `SESSION_ALLOWED_ORIGINS` may list. */
const MAX_ALLOWED_ORIGINS = 20

/** The entries of `SESSION_ALLOWED_ORIGINS`, split and trimmed, not yet checked. */
function splitOrigins(value: string): string[] {
  return value.split(',').map((entry) => entry.trim())
}

/** Whether `entry` is an exact origin (scheme, lower-case host, optional non-default port). */
function isExactOrigin(entry: string, allowHttp: boolean): boolean {
  if (entry.includes('*') || !URL.canParse(entry)) {
    return false
  }
  const url = new URL(entry)
  const schemeOk = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')
  return schemeOk && url.origin === entry
}

/** A secret key setting: 32 to 512 printable characters, optional here and required later. */
function counterSecret(name: string) {
  return z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .max(512, `${name} must be at most 512 characters`)
    .regex(/^[\x21-\x7e]+$/, `${name} must be printable characters with no spaces`)
    .optional()
}

const schema = z
  .object({
    /** Which deployment this is. No default: a deploy that forgets it must fail at boot. */
    ENVIRONMENT: z.enum(['local', 'dev', 'staging', 'prod']),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    /** The longest one readiness check may take before it counts as failed. */
    READINESS_TIMEOUT_MS: z.coerce.number().int().min(1).max(30_000).default(2_000),
    /** The longest shutdown waits for in-flight requests before closing them. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(10_000),
    /** How long `/readyz` reports 503 before the server stops accepting, so the balancer moves on. */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    /** The largest request body accepted, in bytes; anything bigger is a 413. */
    MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1).max(104_857_600).default(1_048_576),
    /**
     * The most database connections this instance opens. Every request that touches Postgres
     * takes one, so the pool is sized to the traffic, not left at a default. At least 4: the
     * purge holds one connection for its lock and needs another for each batch, and requests
     * need some of their own.
     */
    DB_POOL_MAX: z.coerce.number().int().min(4).max(100).default(10),
    /** How often expired sign-in attempts and verification codes are purged, in ms. */
    RETENTION_INTERVAL_MS: z.coerce.number().int().min(100).max(86_400_000).default(600_000),
    /** The most rows one purge statement removes; a run repeats while a batch comes back full. */
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    /** The longest one purge run may take before it stops and waits for the next interval. */
    RETENTION_RUN_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
    /**
     * How many password hashes or verifications run at once. Each takes about 64 MiB and a
     * core for roughly 90 ms, so this is the instance's ceiling on password work.
     */
    HASH_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    /** How many more may wait for a hash slot; past that a request gets a 503 at once. */
    HASH_QUEUE: z.coerce.number().int().min(0).max(1_000).default(16),
    /**
     * How many sign-in password verifications run at once. A lane of its own, so a flood of
     * sign-ups (which hash) cannot shed a sign-in. Each takes about 64 MiB and a core.
     */
    SIGN_IN_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    /** How many more may wait for a sign-in slot; past that a request gets a 503 at once. */
    SIGN_IN_QUEUE: z.coerce.number().int().min(0).max(1_000).default(16),
    /** How many breached-password lookups run at once. */
    BREACH_CHECK_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    /** How many more may wait for a lookup slot; past that a request gets a 503 at once. */
    BREACH_CHECK_QUEUE: z.coerce.number().int().min(0).max(1_000).default(16),
    /**
     * The most requests to the core service in flight at once from this instance. A stalled core
     * then holds this many sockets and no more.
     */
    CORE_CONCURRENCY: z.coerce.number().int().min(1).max(1_000).default(64),
    /** How many more calls to core may wait for a slot; past that a call fails at once (503). */
    CORE_QUEUE: z.coerce.number().int().min(0).max(10_000).default(256),
    /** The Region this deployment serves (ADR 0001); stamped into every token. No default. */
    REGION: regionSchema,
    /** The `closeline_auth` login. Defaults to the local compose database in `local` only. */
    DATABASE_URL: z.string().min(1).optional(),
    /**
     * The master key that seals signing keys at rest: 64 hex characters. Required outside
     * `local`, where a fixed development key is used. Never logged.
     */
    AUTH_MASTER_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'AUTH_MASTER_KEY must be 64 hexadecimal characters')
      .optional(),
    /** Where this service is reached: the `iss` claim of every token. Required outside `local`. */
    PUBLIC_URL: z.url().optional(),
    /** The `aud` claim of every token; the verifiers of the other services expect it. */
    TOKEN_AUDIENCE: z.string().min(1).max(200).default('closeline'),
    /**
     * Where the core service's internal routes are: an origin, `https` outside `local`, with no
     * credentials, query or fragment. Required outside `local`; in `local` with neither this nor
     * the token set, a placeholder adapter is used and nobody can sign up.
     */
    CORE_BASE_URL: z
      .url({ protocol: /^https?$/ })
      .refine((value) => {
        const url = new URL(value)
        // The raw text too: a bare trailing `#` or `?` parses to an empty search or hash.
        return (
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === '' &&
          !value.includes('#') &&
          !value.includes('?')
        )
      }, 'CORE_BASE_URL must not carry credentials, a query or a fragment')
      .optional(),
    /**
     * The shared secret core expects as a bearer token on its internal routes: 32 to 512
     * printable characters. Required outside `local`. Never logged.
     */
    CORE_INTERNAL_TOKEN: z
      .string()
      .min(32, 'CORE_INTERNAL_TOKEN must be at least 32 characters')
      .max(512, 'CORE_INTERNAL_TOKEN must be at most 512 characters')
      .regex(/^[\x21-\x7e]+$/, 'CORE_INTERNAL_TOKEN must be printable characters with no spaces')
      .optional(),
    /**
     * Where a local mailbox (Mailpit) takes mail: exactly `http://127.0.0.1`, `http://[::1]` or
     * `http://localhost`, with an optional port and trailing slash and nothing else. Accepted only when
     * `ENVIRONMENT=local`. With it set, sign-up mail goes to that mailbox; without it the
     * unconfigured mailer stays and sign-up answers `mail.unavailable`.
     */
    MAIL_LOCAL_URL: z.string().optional(),
    /** The `From` address of local mail. Accepted only when `ENVIRONMENT=local`. */
    MAIL_LOCAL_FROM: z.email().optional(),
    /**
     * Only for local development over plain http: `true` drops `Secure` and the `__Secure-`
     * prefix from the refresh cookie. Refused in every other environment. Default `false`.
     */
    SESSION_COOKIE_INSECURE: z.enum(['true', 'false']).optional(),
    /**
     * The origins the portal is served from: a comma-separated list of exact origins (at most
     * 20), `https` outside `local`, no wildcard, path or trailing slash. A browser-client
     * refresh or sign-out must carry an `Origin` in this list. Required outside `local` (a deploy without it fails at boot); unset in `local`, every such
     * request is refused.
     */
    SESSION_ALLOWED_ORIGINS: z.string().optional(),
    /**
     * The key of the HMAC-SHA-256 that turns a sign-in or rate-limit key (an address, never
     * stored) into the hash the counters table holds: 32 to 512 printable characters. Required
     * outside `local`, where a fixed development key is used. Never logged. Rotating it orphans
     * every existing counter, which then expires: the guessing budget of every address restarts
     * once.
     */
    COUNTER_HASH_KEY: counterSecret('COUNTER_HASH_KEY'),
    /**
     * The key that signs the known-device cookie (ADR 0014): 32 to 512 printable characters,
     * different from `COUNTER_HASH_KEY`. Required outside `local`, where a fixed development key
     * is used. Never logged. Rotating it makes every known-device cookie unverifiable, so every
     * device is unknown until it signs in again.
     */
    DEVICE_COOKIE_KEY: counterSecret('DEVICE_COOKIE_KEY'),
  })
  .superRefine((env, ctx) => {
    // Messages name the key and the rule, never the value: a URL can carry credentials.
    for (const key of ['MAIL_LOCAL_URL', 'MAIL_LOCAL_FROM'] as const) {
      if (env[key] !== undefined && env.ENVIRONMENT !== 'local') {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is accepted only when ENVIRONMENT is local`,
        })
      }
    }
    if (env.SESSION_COOKIE_INSECURE === 'true' && env.ENVIRONMENT !== 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_INSECURE'],
        message: 'SESSION_COOKIE_INSECURE=true is accepted only when ENVIRONMENT is local',
      })
    }
    if (env.SESSION_ALLOWED_ORIGINS !== undefined) {
      const entries = splitOrigins(env.SESSION_ALLOWED_ORIGINS)
      const allowHttp = env.ENVIRONMENT === 'local'
      if (
        entries.length > MAX_ALLOWED_ORIGINS ||
        new Set(entries).size !== entries.length ||
        !entries.every((entry) => isExactOrigin(entry, allowHttp))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_ALLOWED_ORIGINS'],
          message: `SESSION_ALLOWED_ORIGINS must list at most ${MAX_ALLOWED_ORIGINS} exact, distinct origins, comma-separated, each like https://host[:port] with a lower-case host, no wildcard, path or trailing slash (http only when ENVIRONMENT is local)`,
        })
      }
    }
    if (env.MAIL_LOCAL_URL !== undefined && localMailboxOrigin(env.MAIL_LOCAL_URL) === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_LOCAL_URL'],
        message:
          'MAIL_LOCAL_URL must be written exactly as http://127.0.0.1, http://[::1] or http://localhost, optionally followed by :port and one trailing slash',
      })
    }
    if (env.ENVIRONMENT === 'local') {
      // Both or neither: half a configuration would quietly fall back to the placeholder.
      for (const [key, other] of [
        ['CORE_BASE_URL', 'CORE_INTERNAL_TOKEN'],
        ['CORE_INTERNAL_TOKEN', 'CORE_BASE_URL'],
      ] as const) {
        if (env[key] !== undefined && env[other] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [other],
            message: `${other} is required with ${key}`,
          })
        }
      }
      return
    }
    for (const key of [
      'DATABASE_URL',
      'AUTH_MASTER_KEY',
      'PUBLIC_URL',
      'CORE_BASE_URL',
      'CORE_INTERNAL_TOKEN',
      'SESSION_ALLOWED_ORIGINS',
      'COUNTER_HASH_KEY',
      'DEVICE_COOKIE_KEY',
    ] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required outside local` })
      }
    }
    if (env.COUNTER_HASH_KEY !== undefined && env.COUNTER_HASH_KEY === env.DEVICE_COOKIE_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEVICE_COOKIE_KEY'],
        message: 'DEVICE_COOKIE_KEY must differ from COUNTER_HASH_KEY',
      })
    }
    if (
      env.CORE_BASE_URL !== undefined &&
      !env.CORE_BASE_URL.toLowerCase().startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORE_BASE_URL'],
        message: 'CORE_BASE_URL must use https outside local',
      })
    }
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })
  .transform((env) =>
    // Keep the canonical origin, so nothing downstream sees another spelling of the address.
    env.MAIL_LOCAL_URL === undefined
      ? env
      : { ...env, MAIL_LOCAL_URL: localMailboxOrigin(env.MAIL_LOCAL_URL) ?? env.MAIL_LOCAL_URL }
  )

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/**
 * The master key of the `local` environment only, so a developer needs no setup. It protects
 * nothing: `loadEnv` refuses to fall back to it anywhere else.
 */
export const LOCAL_MASTER_KEY = '00112233445566778899aabbccddeeff'.repeat(2)

/** The counter hash key of the `local` environment only; `loadEnv` refuses it anywhere else. */
export const LOCAL_COUNTER_HASH_KEY = 'local-counter-hash-key-not-a-secret-0001'

/** The known-device cookie key of the `local` environment only; refused anywhere else. */
export const LOCAL_DEVICE_COOKIE_KEY = 'local-device-cookie-key-not-a-secret-0002'

/** The compose database's `closeline_auth` login, for `local` and the integration tests. */
export function localDatabaseUrl(source: Record<string, string | undefined> = process.env): string {
  return `postgres://closeline_auth:closeline_auth_local@127.0.0.1:${source.POSTGRES_PORT || '5432'}/closeline`
}

/** Parse configuration from the given variables, failing fast on anything invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return schema.parse(source)
}

/** The database URL in force: the configured one, or the compose database in `local`. */
export function databaseUrl(
  env: Env,
  source: Record<string, string | undefined> = process.env
): string {
  return env.DATABASE_URL ?? localDatabaseUrl(source)
}

/** The master key in force: the configured one, or the development key in `local`. */
export function masterKey(env: Env): string {
  return env.AUTH_MASTER_KEY ?? LOCAL_MASTER_KEY
}

/** The counter hash key in force: the configured one, or the development key in `local`. */
export function counterHashKey(env: Env): string {
  return env.COUNTER_HASH_KEY ?? LOCAL_COUNTER_HASH_KEY
}

/** The known-device cookie key in force: the configured one, or the development key in `local`. */
export function deviceCookieKey(env: Env): string {
  return env.DEVICE_COOKIE_KEY ?? LOCAL_DEVICE_COOKIE_KEY
}

/** The issuer of every token: the configured URL, or this machine's address in `local`. */
export function publicUrl(env: Env): string {
  return (env.PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '')
}

/** Whether the refresh cookie drops `Secure` and its prefix (`local` only, validated at boot). */
export function sessionCookieInsecure(env: Env): boolean {
  return env.SESSION_COOKIE_INSECURE === 'true'
}

/** The origins allowed to call the cookie-authenticated routes; empty when none is configured. */
export function allowedOrigins(env: Env): readonly string[] {
  return env.SESSION_ALLOWED_ORIGINS === undefined ? [] : splitOrigins(env.SESSION_ALLOWED_ORIGINS)
}
