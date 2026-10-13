import type { RequestId } from 'tula-closeline-contract'
import type { Logger } from 'tula-closeline-kit'

/** The Hono environment every route shares: what the middleware puts on the request context. */
export type AppEnv = {
  Variables: {
    /** The request's id: the caller's when well-formed, otherwise minted here. */
    requestId: RequestId
    /** A logger that adds the request id to every line. */
    logger: Logger
  }
}
