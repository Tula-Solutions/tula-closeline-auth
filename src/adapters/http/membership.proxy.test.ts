import { afterAll, describe, expect, test } from 'bun:test'
import { type FakeCore, startFakeCore } from '~/testing/fake-core'

const INVITATION = `inv-${'q'.repeat(30)}`
const CHILD = new URL('./proxy-probe-child.ts', import.meta.url).pathname

/** Every spelling of a proxy variable that Bun or a tool may read. */
const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const

type ProxyVariable = (typeof PROXY_VARIABLES)[number]

/**
 * Whether Bun 1.4.2's `fetch` is known to honour the variable for an `http:` URL. The kit's probe
 * (`src/http/proxy.test.ts`) pins this: `ALL_PROXY` and the `https` pair are not read for it. The
 * control in the child is expected to reach the proxy exactly when this is true, so a Bun change
 * in either direction fails this test and is looked at, rather than silently making it blind.
 */
const FETCH_HONOURS: Record<ProxyVariable, boolean> = {
  HTTP_PROXY: true,
  http_proxy: true,
  HTTPS_PROXY: false,
  https_proxy: false,
  ALL_PROXY: false,
  all_proxy: false,
}

type StandInProxy = { url: string; seen: string[]; stop: () => void }

/** A listener that records the first bytes of every connection and then closes it. */
function startProxy(): StandInProxy {
  const seen: string[] = []
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) {
        seen.push(Buffer.from(data).toString('latin1'))
        socket.end()
      },
      open() {},
      close() {},
      error() {},
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const cores: FakeCore[] = []
const proxies: StandInProxy[] = []
afterAll(async () => {
  await Promise.all(cores.map((core) => core.stop()))
  for (const proxy of proxies) {
    proxy.stop()
  }
})

/** Runs the child with `variables` set to a stand-in proxy and returns what each side saw. */
async function run(variables: readonly ProxyVariable[]) {
  const core = startFakeCore()
  cores.push(core)
  core.invite(INVITATION, { email: 'rep@example.com' })
  const proxy = startProxy()
  proxies.push(proxy)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
  }
  for (const name of variables) {
    env[name] = proxy.url
  }
  const child = Bun.spawn([process.execPath, CHILD, core.url, core.secret, INVITATION], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { core, proxy, lines: stdout.trim().split('\n'), exitCode }
}

describe('internal calls never reach a proxy named in the environment (ADR 0013)', () => {
  test.each([...PROXY_VARIABLES])(
    '%s: all four operations reach core and the proxy sees none of them',
    async (variable) => {
      const { core, proxy, lines, exitCode } = await run([variable])

      // The child ran to the end (a crash cannot pass) and every operation got an answer.
      expect(lines.at(-1)).toBe('done')
      expect(exitCode).toBe(0)
      expect(lines.slice(0, 4)).toEqual(['lookup ok', 'create ok', 'accept ok', 'abandon ok'])
      const internal = core.requests.filter((request) => request.path.startsWith('/internal/'))
      expect(internal.map((request) => request.path)).toEqual([
        '/internal/membership',
        '/internal/organizations',
        '/internal/invitations/accept',
        expect.stringMatching(/^\/internal\/organizations\/org_[^/]+\/abandon$/),
      ])
      for (const request of internal) {
        expect(request.headers.authorization).toBe(`Bearer ${core.secret}`)
      }

      // Nothing internal, and no secret, ever reached the proxy.
      const heard = proxy.seen.join('\n')
      expect(heard).not.toContain('/internal/')
      expect(heard).not.toContain(core.secret)
      expect(heard).not.toContain(INVITATION)

      // The positive control: where `fetch` honours the variable, its request is at the proxy, so
      // this test can see a leak. Where it does not, the control reached nothing either.
      expect(lines[4]?.startsWith(FETCH_HONOURS[variable] ? 'control error' : 'control ok')).toBe(
        true
      )
      expect(proxy.seen.some((bytes) => bytes.includes('/control'))).toBe(FETCH_HONOURS[variable])
      expect(core.requests.some((request) => request.path === '/control')).toBe(
        !FETCH_HONOURS[variable]
      )
    },
    30_000
  )

  test('all six variables at once, as a deployment might leave them', async () => {
    const { core, proxy, lines, exitCode } = await run(PROXY_VARIABLES)

    expect(lines.at(-1)).toBe('done')
    expect(exitCode).toBe(0)
    expect(lines.slice(0, 4)).toEqual(['lookup ok', 'create ok', 'accept ok', 'abandon ok'])
    expect(core.requests.filter((r) => r.path.startsWith('/internal/'))).toHaveLength(4)
    const heard = proxy.seen.join('\n')
    expect(heard).not.toContain('/internal/')
    expect(heard).not.toContain(core.secret)
    // `fetch` in the same process did go to the proxy: the test would have caught a leak.
    expect(proxy.seen.some((bytes) => bytes.includes('/control'))).toBe(true)
  }, 30_000)
})
