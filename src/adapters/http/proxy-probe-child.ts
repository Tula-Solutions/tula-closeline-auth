/**
 * Child process of `membership.proxy.test.ts`. Proxy variables are read when a process starts, so
 * the test starts this one with them in its environment. It runs every operation of the HTTP
 * membership adapter against the stand-in core, then a plain `fetch` as a positive control, and
 * prints one line per step and a final `done`: a run without `done` never reached the end.
 * Arguments: the core origin, the shared secret, an invitation token the stand-in honours.
 */
import { formatId } from 'tula-closeline-contract'
import { createHttpMembership } from './membership'

const [url, secret, invitationToken] = process.argv.slice(2)
if (url === undefined || secret === undefined || invitationToken === undefined) {
  throw new Error('usage: proxy-probe-child <url> <secret> <invitation token>')
}

const adapter = createHttpMembership({
  baseUrl: url,
  token: secret,
  environment: 'local',
  retryDelayMs: () => 0,
})

/** Runs one step and prints `<name> ok` or `<name> error <error name>`. */
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
    process.stdout.write(`${name} ok\n`)
  } catch (error) {
    process.stdout.write(`${name} error ${error instanceof Error ? error.name : 'unknown'}\n`)
  }
}

const userId = () => formatId('usr', crypto.randomUUID())

await step('lookup', () => adapter.forUser(userId()))
await step('create', () =>
  adapter.createOrganization({
    userId: userId(),
    name: 'Northline',
    email: 'maya@northline.app',
    memberName: null,
    idempotencyKey: crypto.randomUUID(),
  })
)
await step('accept', () =>
  adapter.acceptInvitation({
    userId: userId(),
    invitationToken,
    email: 'rep@example.com',
    memberName: null,
    idempotencyKey: crypto.randomUUID(),
  })
)
await step('abandon', () =>
  adapter.abandonOrganization({
    organizationId: formatId('org', crypto.randomUUID()),
    userId: userId(),
    idempotencyKey: crypto.randomUUID(),
  })
)
// The positive control: `fetch` honours a proxy variable, so this request should arrive at the proxy.
await step('control', () => fetch(`${url}/control`, { signal: AbortSignal.timeout(3000) }))
process.stdout.write('done' + '\n')
