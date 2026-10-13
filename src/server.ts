import { createApp } from '~/app'
import { createContainer } from '~/container'
import { describeError } from '~/describe-error'
import { serveOptions } from '~/http/serve'
import * as Abandon from '~/modules/abandon/service'
import * as Bootstrap from '~/modules/bootstrap/service'
import * as Jwks from '~/modules/jwks/service'
import * as Retention from '~/modules/retention/service'
import { shutdown } from '~/shutdown'

const container = createContainer()
let retention: Retention.Retention
let abandonSweep: Abandon.Sweeper
try {
  const tenant = await Bootstrap.start(container)
  await Jwks.ensureAtBoot(container, tenant)
  // Purges expired attempts and codes now and on an interval; stopped before the pool closes.
  retention = Retention.start(container, tenant)
  // Abandons Organizations that sign-ups made and nobody owns (hub issue 36), under its own lock.
  abandonSweep = Abandon.start(container, tenant)
} catch (error) {
  // Refuse to serve rather than run against a Region that has no, or more than one, project.
  container.logger.error('bootstrap failed', { error: describeError(error) })
  await container.close().catch(() => {})
  process.exit(1)
}
const app = createApp(container)
const server = Bun.serve(serveOptions(container, app))

container.logger.info('listening', { port: server.port, environment: container.env.ENVIRONMENT })

function stop(signal: string): void {
  void shutdown({
    signal,
    server,
    lifecycle: container.lifecycle,
    clock: container.clock,
    logger: container.logger,
    graceMs: container.env.SHUTDOWN_GRACE_MS,
    timeoutMs: container.env.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => {
      Promise.all([retention.stop(), abandonSweep.stop()])
        .catch(() => {})
        .then(() => container.close())
        .catch(() => {})
        .finally(() => process.exit(code))
    },
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
