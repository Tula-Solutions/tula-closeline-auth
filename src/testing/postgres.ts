import { Pool } from 'pg'

/** The compose database port; `POSTGRES_PORT` moves it when 5432 is taken. */
function port(): string {
  return process.env.POSTGRES_PORT || '5432'
}

/** The owner login of the compose database: migrations and test set-up only, never the service. */
export function ownerUrl(): string {
  return (
    process.env.DATABASE_URL_OWNER ??
    `postgres://closeline_owner:closeline_owner_local@127.0.0.1:${port()}/closeline`
  )
}

/** The `closeline_auth` login: what the service itself connects as. */
export function authUrl(): string {
  return (
    process.env.DATABASE_URL ??
    `postgres://closeline_auth:closeline_auth_local@127.0.0.1:${port()}/closeline`
  )
}

/** Refuses to run destructive test set-up against a database that is not on this machine. */
function assertLoopback(url: string): void {
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to reset test data on ${host}: it is not loopback`)
  }
}

let migrated: Promise<void> | undefined

/** Apply the pinned tula-closeline-db migrations once per process, as the owner role. */
export function migrate(): Promise<void> {
  migrated ??= (async () => {
    assertLoopback(ownerUrl())
    const child = Bun.spawn(['bun', 'node_modules/tula-closeline-db/scripts/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: ownerUrl() },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (code !== 0) {
      throw new Error(`db:migrate failed: ${err}`)
    }
  })()
  return migrated
}

/** An owner connection for set-up and for reading around the service's grants. */
export function ownerPool(): Pool {
  assertLoopback(ownerUrl())
  return new Pool({ connectionString: ownerUrl(), max: 2 })
}

/** Remove every row of the auth schema, cascading from the workspaces, as the owner. */
export async function resetAuthData(owner: Pool): Promise<void> {
  await owner.query('truncate table auth.workspaces cascade')
}
