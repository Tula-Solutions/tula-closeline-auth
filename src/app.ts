import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Container } from '~/container'
import { createBaseApp } from '~/http/base'
import type { AppEnv } from '~/http/types'
import { createFlowRouter } from '~/modules/flow/router'
import { createHealthRouter } from '~/modules/health/router'
import { createJwksRouter } from '~/modules/jwks/router'
import { createUserRouter } from '~/modules/user/router'
import { serveOpenApi } from '~/openapi'

/** Build the HTTP app from a container. Modules are mounted here as they are added. */
export function createApp(container: Container): OpenAPIHono<AppEnv> {
  const app = createBaseApp(container)

  app.route('/', createHealthRouter(container))
  app.route('/', createJwksRouter(container))
  app.route('/', createFlowRouter(container))
  app.route('/', createUserRouter(container))
  serveOpenApi(app)

  return app
}
