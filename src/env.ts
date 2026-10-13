import { regionSchema } from 'tula-closeline-contract'
import { z } from 'zod'

/** The most grace plus drain may add up to, so an orchestrator's kill window is not outlasted. */
const MAX_SHUTDOWN_TOTAL_MS = 60_000

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
     * takes one, so the pool is sized to the traffic, not left at a default.
     */
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** How often expired sign-in attempts and verification codes are purged, in ms. */
    RETENTION_INTERVAL_MS: z.coerce.number().int().min(100).max(86_400_000).default(600_000),
    /** The most rows one purge statement removes; a run repeats while a batch comes back full. */
    RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
    /** The longest one purge run may take before it stops and waits for the next interval. */
    RETENTION_RUN_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
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
  })
  .superRefine((env, ctx) => {
    if (env.ENVIRONMENT === 'local') {
      return
    }
    for (const key of ['DATABASE_URL', 'AUTH_MASTER_KEY', 'PUBLIC_URL'] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required outside local` })
      }
    }
  })
  .refine((env) => env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS <= MAX_SHUTDOWN_TOTAL_MS, {
    message: `SHUTDOWN_GRACE_MS plus SHUTDOWN_TIMEOUT_MS must not exceed ${MAX_SHUTDOWN_TOTAL_MS} ms in total`,
    path: ['SHUTDOWN_TIMEOUT_MS'],
  })

/** The validated process configuration. */
export type Env = z.infer<typeof schema>

/**
 * The master key of the `local` environment only, so a developer needs no setup. It protects
 * nothing: `loadEnv` refuses to fall back to it anywhere else.
 */
export const LOCAL_MASTER_KEY = '00112233445566778899aabbccddeeff'.repeat(2)

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

/** The issuer of every token: the configured URL, or this machine's address in `local`. */
export function publicUrl(env: Env): string {
  return (env.PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, '')
}
