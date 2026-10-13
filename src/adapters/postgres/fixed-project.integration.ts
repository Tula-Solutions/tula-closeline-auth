import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDb } from 'tula-closeline-db'
import { fixedProjectSuite } from '~/adapters/fixed-project.suite'
import { createPostgresFixedProject } from '~/adapters/postgres/fixed-project'
import { authUrl, migrate, ownerPool, resetAuthData } from '~/testing/postgres'

const owner = ownerPool()
const handle = createDb(authUrl())

beforeAll(migrate)
afterAll(async () => {
  await handle.close()
  await owner.end()
})

fixedProjectSuite('postgres', async () => {
  await resetAuthData(owner)
  return {
    adapter: createPostgresFixedProject(handle.db),
    plantSecondProject: async () => {
      const workspace = crypto.randomUUID()
      await owner.query("insert into auth.workspaces (id, name) values ($1, 'other')", [workspace])
      await owner.query(
        "insert into auth.projects (id, workspace_id, name) values ($1, $2, 'other')",
        [crypto.randomUUID(), workspace]
      )
    },
  }
})

describe('postgres fixed project, as written to the tables', () => {
  test('twelve concurrent starts leave one workspace, one project and two environments', async () => {
    await resetAuthData(owner)
    const adapter = createPostgresFixedProject(handle.db)
    const id = () => crypto.randomUUID()

    await Promise.all(
      Array.from({ length: 12 }, () =>
        adapter.ensure(
          'development',
          { workspace: id(), project: id(), development: id(), production: id() },
          new Date()
        )
      )
    )

    const count = async (table: string) =>
      Number((await owner.query(`select count(*)::int as n from auth.${table}`)).rows[0].n)
    expect(await count('workspaces')).toBe(1)
    expect(await count('projects')).toBe(1)
    expect(await count('environments')).toBe(2)
  })

  test('the service role cannot delete its project, so the Region cannot lose it', async () => {
    const adapter = createPostgresFixedProject(handle.db)
    const id = () => crypto.randomUUID()
    await adapter.ensure(
      'development',
      { workspace: id(), project: id(), development: id(), production: id() },
      new Date()
    )

    const attempt = async () => {
      await handle.db.execute(sql`delete from auth.projects`)
    }

    await expect(attempt()).rejects.toThrow()
  })
})
