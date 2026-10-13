import type { OpenAPIHono } from '@hono/zod-openapi'
import type { AppEnv } from '~/http/types'
import type { TestDeps } from '~/testing'

/** What a test sends: a JSON body and the credentials a step needs. */
export type CallOptions = {
  body?: unknown
  /** The attempt secret (`x-tula-attempt`). */
  attempt?: string
  /** A bearer access token. */
  accessToken?: string
  client?: string
  /** Any other request headers, e.g. `origin` or `cookie`; they win over the ones above. */
  headers?: Record<string, string>
}

/** A response with its JSON body parsed (or `null`). */
export type Reply = {
  status: number
  body: unknown
  headers: Headers
}

/** Calls the app in-process, as an HTTP client would. */
export async function call(
  app: OpenAPIHono<AppEnv>,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (options.attempt !== undefined) {
    headers['x-tula-attempt'] = options.attempt
  }
  if (options.accessToken !== undefined) {
    headers.authorization = `Bearer ${options.accessToken}`
  }
  if (options.client !== undefined) {
    headers['x-tula-client'] = options.client
  }
  Object.assign(headers, options.headers)
  const response = await app.request(path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? null : JSON.parse(text),
    headers: response.headers,
  }
}

/** The six-digit code in the most recent email sent to `to`; throws when there is none. */
export function emailedCode(deps: Pick<TestDeps, 'mailer'>, to: string): string {
  const message = [...deps.mailer.outbox]
    .reverse()
    .find((m) => m.to.toLowerCase() === to.toLowerCase())
  const code = message ? /\b(\d{6})\b/.exec(message.text)?.[1] : undefined
  if (!code) {
    throw new Error(`no code was emailed to ${to}`)
  }
  return code
}

/** A code that is six digits and not the right one. */
export function wrongCode(right: string): string {
  return right === '000000' ? '111111' : '000000'
}

/** Reads a dotted path out of a parsed body; `undefined` when any step is missing. */
export function at(body: unknown, path: string): unknown {
  let current: unknown = body
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Reads a string at a dotted path; throws, naming the path, when it is not one. */
export function text(body: unknown, path: string): string {
  const value = at(body, path)
  if (typeof value !== 'string') {
    throw new Error(`expected a string at ${path}`)
  }
  return value
}
