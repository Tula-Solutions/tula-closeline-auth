import type { IdGenerator } from '~/ports/id-generator'

/** Time-ordered UUIDs (version 7) from the CSPRNG-backed runtime. */
export const uuidV7Ids: IdGenerator = { next: () => Bun.randomUUIDv7() }
