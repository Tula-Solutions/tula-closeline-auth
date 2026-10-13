import { afterAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { MailMessage } from '~/ports/mailer'
import { createMailpitMailer, type MailpitMailerOptions } from './mailer'

/** A message whose every part is recognisable, so a leak into a log or an error is found. */
const MESSAGE: MailMessage = {
  to: 'zed.leak@example.com',
  subject: 'Subject-marker-9f3',
  text: 'Your code is 481516. Link: https://app.example.com/verify?token=tok-marker-77c',
  html: '<p>Your code is <b>481516</b>. <a href="https://app.example.com/verify?token=tok-marker-77c">Open</a></p>',
}
const SENSITIVE = ['zed.leak', 'Subject-marker-9f3', '481516', 'tok-marker-77c', 'app.example.com']

type Seen = { method: string; url: string; path: string; contentType: string | null; body: string }
type Stand = {
  url: string
  seen: Seen[]
  respond: (request: Request, attempt: number) => Response | Promise<Response>
  stop: () => Promise<void>
}

const stands: Stand[] = []
afterAll(async () => {
  await Promise.all(stands.map((stand) => stand.stop()))
})

/** A stand-in for Mailpit on a loopback port; `respond` decides each answer. */
function stand(respond: Stand['respond'] = () => Response.json({ ID: 'abc' })): Stand {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        url: request.url,
        path: new URL(request.url).pathname,
        contentType: request.headers.get('content-type'),
        body: await request.clone().text(),
      })
      return respond(request, seen.length)
    },
  })
  const made: Stand = {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    respond,
    stop: async () => {
      await server.stop(true)
    },
  }
  stands.push(made)
  return made
}

/** Collects what is logged, as the text of every call. */
function recordingLogger() {
  const lines: string[] = []
  const record = (message: string, fields?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ message, fields }))
  }
  return { lines, logger: { warn: record, error: record, info: record, debug: record } }
}

function connect(target: Stand, options: Partial<MailpitMailerOptions> = {}) {
  const log = recordingLogger()
  const mailer = createMailpitMailer({
    baseUrl: target.url,
    from: 'no-reply@closeline.test',
    logger: log.logger,
    retryDelayMs: () => 0,
    ...options,
  })
  return { mailer, log }
}

function expectNoLeak(texts: string[]) {
  for (const text of texts) {
    for (const secret of SENSITIVE) {
      expect(text).not.toContain(secret)
    }
  }
}

describe('the request', () => {
  test("matches Mailpit's send API exactly", async () => {
    const mailpit = stand()
    const { mailer } = connect(mailpit)

    await mailer.send(MESSAGE)

    expect(mailpit.seen).toHaveLength(1)
    const [request] = mailpit.seen
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/api/v1/send')
    expect(request?.contentType).toContain('application/json')
    expect(JSON.parse(request?.body ?? '')).toEqual({
      From: { Email: 'no-reply@closeline.test' },
      To: [{ Email: MESSAGE.to }],
      Subject: MESSAGE.subject,
      Text: MESSAGE.text,
      HTML: MESSAGE.html,
    })
  })

  test('a base URL with a trailing slash reaches exactly <origin>/api/v1/send', async () => {
    const mailpit = stand()
    const { mailer } = connect(mailpit, { baseUrl: `${mailpit.url}/` })

    await mailer.send(MESSAGE)

    expect(mailpit.seen[0]?.url).toBe(`${mailpit.url}/api/v1/send`)
  })
})

describe('failure', () => {
  test('a 5xx is retried within the bound, then fails without leaking', async () => {
    const mailpit = stand(() => new Response('upstream said 481516', { status: 503 }))
    const { mailer, log } = connect(mailpit)

    const error = await mailer.send(MESSAGE).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(Error)
    expect(mailpit.seen).toHaveLength(3)
    expectNoLeak([...log.lines, String((error as Error).message)])
    expect(log.lines.join('')).toContain('503')
  })

  test('a 5xx that clears is delivered on the retry', async () => {
    const mailpit = stand((_request, attempt) =>
      attempt === 1 ? new Response('no', { status: 502 }) : Response.json({ ID: 'ok' })
    )
    const { mailer } = connect(mailpit)

    await mailer.send(MESSAGE)

    expect(mailpit.seen).toHaveLength(2)
  })

  test('a 4xx is not retried', async () => {
    const mailpit = stand(() =>
      Response.json({ Error: 'bad zed.leak@example.com' }, { status: 400 })
    )
    const { mailer, log } = connect(mailpit)

    const error = await mailer.send(MESSAGE).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(Error)
    expect(mailpit.seen).toHaveLength(1)
    expectNoLeak([...log.lines, String((error as Error).message)])
  })

  test('a redirect is not followed and not retried', async () => {
    const mailpit = stand(
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:1/x' } })
    )
    const { mailer } = connect(mailpit)

    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(Error)
    expect(mailpit.seen).toHaveLength(1)
  })

  test('a slow server hits the timeout and the send rejects', async () => {
    const mailpit = stand(async () => {
      await Bun.sleep(500)
      return Response.json({ ID: 'late' })
    })
    const { mailer, log } = connect(mailpit, { timeoutMs: 25 })

    const error = await mailer.send(MESSAGE).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(Error)
    expectNoLeak([...log.lines, String((error as Error).message)])
  })

  test('a timeout is retried within the bound, then fails as a timeout', async () => {
    const mailpit = stand(async () => {
      await Bun.sleep(1_000)
      return Response.json({ ID: 'late' })
    })
    const { mailer, log } = connect(mailpit, { timeoutMs: 100 })

    const error = await mailer.send(MESSAGE).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect((error as Error).message).toContain('timeout')
    expect((error as Error).message).toContain('3 attempts')
    expect(log.lines).toHaveLength(2)
    expect(mailpit.seen).toHaveLength(3)
  })

  test('an answer that never ends is not read, and the send still settles', async () => {
    const mailpit = stand(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('zed.leak@example.com 481516 '))
            },
          })
        )
    )
    const { mailer, log } = connect(mailpit, { timeoutMs: 2_000 })

    await mailer.send(MESSAGE)

    expectNoLeak(log.lines)
  })

  test('nothing listening is retried, then rejects without leaking', async () => {
    const closed = stand()
    await closed.stop()
    const { mailer, log } = connect(closed)

    const error = await mailer.send(MESSAGE).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(Error)
    expect(log.lines.length).toBeGreaterThan(0)
    expectNoLeak([...log.lines, String((error as Error).message)])
  })

  test('nothing sensitive is logged on a delivery that works', async () => {
    const mailpit = stand()
    const { mailer, log } = connect(mailpit)

    await mailer.send(MESSAGE)

    expectNoLeak(log.lines)
  })

  test('the retry pause is jittered by the injected function and bounded in count', async () => {
    const mailpit = stand(() => new Response('x', { status: 500 }))
    const pauses: number[] = []
    const { mailer } = connect(mailpit, {
      retryDelayMs: () => {
        pauses.push(1)
        return 0
      },
    })

    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(Error)

    expect(pauses).toHaveLength(2)
    expect(mailpit.seen).toHaveLength(3)
  })
})

describe('proxy variables', () => {
  const PROXY_VARIABLES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY']

  test('the message goes straight to the loopback mailbox, whatever the proxy variables say', async () => {
    const proxy = stand()
    const mailbox = stand()
    const saved = new Map(PROXY_VARIABLES.map((name) => [name, process.env[name]]))
    const noProxy = [process.env.NO_PROXY, process.env.no_proxy]
    try {
      for (const name of PROXY_VARIABLES) {
        process.env[name] = proxy.url
      }
      process.env.NO_PROXY = ''
      process.env.no_proxy = ''
      const { mailer } = connect(mailbox)

      await mailer.send(MESSAGE)

      expect(proxy.seen).toHaveLength(0)
      expect(mailbox.seen).toHaveLength(1)
    } finally {
      // An empty value, not `delete`: in this Bun version a deleted proxy variable is still
      // honoured by later `fetch` calls in the same process (the membership tests would fail),
      // while an empty one means no proxy.
      for (const [name, value] of [
        ...saved,
        ['NO_PROXY', noProxy[0]],
        ['no_proxy', noProxy[1]],
      ] as const) {
        if (value !== undefined || name.toLowerCase() !== 'no_proxy') {
          process.env[name] = value ?? ''
        }
      }
    }
  })
})

/** Whether this machine can listen on the IPv6 loopback address. */
function hasIpv6Loopback(): boolean {
  try {
    Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response() }).stop(true)
    return true
  } catch {
    return false
  }
}

describe('loopback addresses', () => {
  test.skipIf(!hasIpv6Loopback())('a mailbox on [::1] takes the message', async () => {
    const seen: string[] = []
    const server = Bun.serve({
      hostname: '::1',
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname)
        return Response.json({ ID: 'v6' })
      },
    })
    try {
      const { mailer } = connect(stand(), { baseUrl: `http://[::1]:${server.port}` })

      await mailer.send(MESSAGE)

      expect(seen).toEqual(['/api/v1/send'])
    } finally {
      await server.stop(true)
    }
  })

  test('a name that resolves outside loopback fails the send, unretried, without connecting', async () => {
    const mailbox = stand()
    const port = new URL(mailbox.url).port
    const asked: string[] = []
    const { mailer, log } = connect(mailbox, {
      baseUrl: `http://localhost:${port}`,
      lookup: (hostname, _options, callback) => {
        asked.push(hostname)
        callback(null, '203.0.113.5', 4)
      },
    })

    const error = await mailer.send(MESSAGE).then(
      () => undefined,
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(Error)
    expect(asked).toEqual(['localhost'])
    expect(mailbox.seen).toHaveLength(0)
    expect(String((error as Error).message)).not.toContain('203.0.113.5')
    expect(String((error as Error).message)).toContain('1 attempt')
    expectNoLeak([...log.lines, String((error as Error).message)])
    expect(log.lines.join('')).not.toContain('203.0.113.5')
  })

  test.each([
    ['an IPv4 address outside 127.0.0.0/8', [{ address: '10.0.0.1', family: 4 }]],
    ['an IPv6 address that is not ::1', [{ address: '2001:db8::1', family: 6 }]],
    ['an IPv4-mapped address', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    [
      'a list with one address outside loopback',
      [
        { address: '127.0.0.1', family: 4 },
        { address: '203.0.113.5', family: 4 },
      ],
    ],
    ['no address', []],
  ])('a name that resolves to %s is refused', async (_name, addresses) => {
    const mailbox = stand()
    const { mailer } = connect(mailbox, {
      baseUrl: `http://localhost:${new URL(mailbox.url).port}`,
      lookup: (_hostname, _options, callback) => {
        // Answers in the shape asked for: a list when `all` is set, else the first address.
        const first = addresses[0]
        if (_options.all) {
          callback(null, addresses)
        } else if (first) {
          callback(null, first.address, first.family)
        } else {
          callback(new Error('no address'), '', 4)
        }
      },
    })

    await expect(mailer.send(MESSAGE)).rejects.toBeInstanceOf(Error)
    expect(mailbox.seen).toHaveLength(0)
  })

  test('a name that resolves to 127.0.0.1 is used', async () => {
    const mailbox = stand()
    const { mailer } = connect(mailbox, {
      baseUrl: `http://localhost:${new URL(mailbox.url).port}`,
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          callback(null, [{ address: '127.0.0.1', family: 4 }])
        } else {
          callback(null, '127.0.0.1', 4)
        }
      },
    })

    await mailer.send(MESSAGE)

    expect(mailbox.seen).toHaveLength(1)
  })

  test('a literal address never consults the resolver', async () => {
    const mailbox = stand()
    let asked = 0
    const { mailer } = connect(mailbox, {
      lookup: (_hostname, _options, callback) => {
        asked += 1
        callback(null, '203.0.113.5', 4)
      },
    })

    await mailer.send(MESSAGE)

    expect(asked).toBe(0)
    expect(mailbox.seen).toHaveLength(1)
  })
})

describe('the connection after an answer', () => {
  test('is closed once the send resolves on an answer that never ends', async () => {
    let closed: () => void = () => {}
    const socketClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const server = createServer((_request, response) => {
      response.writeHead(200)
      response.write('zed.leak@example.com 481516 ')
    })
    server.on('connection', (socket) => {
      socket.on('close', closed)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const { mailer } = connect(stand(), {
        baseUrl: `http://127.0.0.1:${port}`,
        // Longer than the wait below, so only the adapter closing the socket can end it.
        timeoutMs: 60_000,
      })

      await mailer.send(MESSAGE)

      // Bounded wait for the server to see the close; no assertion on how long it took.
      await Promise.race([
        socketClosed,
        Bun.sleep(5_000).then(() => {
          throw new Error('the connection was left open after the answer')
        }),
      ])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
