import { createApp } from '~/app'
import { createContainer } from '~/container'
import { serveOptions } from '~/http/serve'
import { shutdown } from '~/shutdown'

const container = createContainer()
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
    exit: (code) => process.exit(code),
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
