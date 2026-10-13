import { createApp } from '~/app'
import { createContainer } from '~/container'
import { describeError } from '~/describe-error'
import { serveOptions } from '~/http/serve'
import * as Bootstrap from '~/modules/bootstrap/service'
import { shutdown } from '~/shutdown'

const container = createContainer()
try {
  await Bootstrap.start(container)
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
      container
        .close()
        .catch(() => {})
        .finally(() => process.exit(code))
    },
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
