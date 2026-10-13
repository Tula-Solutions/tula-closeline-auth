import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { createBaseApp } from '~/http/base'
import type { AppEnv } from '~/http/types'
import { createHealthRouter } from '~/modules/health/router'
import { serveOpenApi } from '~/openapi'

/** Build the HTTP app from a container. Modules are mounted here as they are added. */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)

  app.route('/', createHealthRouter(container))
  serveOpenApi(app)

  return app
}
