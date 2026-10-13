import { type SQL, sql } from 'drizzle-orm'

/**
 * Turns one of the db library's numbered-parameter statements (`$1`, `$2`, ...) into a Drizzle
 * query, so it runs on a transaction's own connection (inside `withEnvironment`) with each value
 * bound as a parameter. The text is the library's, never built from input.
 */
export function statement(text: string, values: readonly unknown[]): SQL {
  const parts = text.split(/\$(\d+)/)
  const chunks = parts.map((part, index) =>
    index % 2 === 0 ? sql.raw(part) : sql`${values[Number(part) - 1]}`
  )
  return sql.join(chunks, sql.raw(''))
}
