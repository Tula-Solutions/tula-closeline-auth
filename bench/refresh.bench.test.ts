import { expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { createReadyDeps } from '../src/testing'
import { at, call, emailedCode, text } from '../src/testing/client'
import { BATCH_REQUESTS, BATCHES, measure, summary } from './measure'

// The refresh path: every signed-in device calls it once a minute, so it is this service's
// steady load. Its cost per call is O(1) in the number of users, sessions and Organizations:
// one token lookup by hash, one membership read, one Ed25519 signature, one rotation.
// Measured over the memory adapters, so it times the service's own work, not the network.
// Typical best batch: 59 ms for 500 refreshes (about 0.12 ms each). The budget is five times it,
// rounded up. A regression such as a per-call key import or an unbounded scan fails.
const BUDGET_MS = 300

test(`refresh: the best of ${BATCHES} batches of ${BATCH_REQUESTS} refreshes is within ${BUDGET_MS} ms`, async () => {
  const deps = await createReadyDeps()
  const app = createApp(deps)
  const email = 'bench@northline.app'
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    body: { email, password: 'correct horse battery', organizationName: 'Northline' },
  })
  const done = await call(
    app,
    'POST',
    `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
    {
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    }
  )
  let token = text(done.body, 'session.refreshToken')

  const result = await measure(async () => {
    const next = await call(app, 'POST', '/v1/client/sessions/refresh', {
      body: { refreshToken: token },
    })
    token = text(next.body, 'refreshToken')
    deps.clock.advance('1s')
    if (at(next.body, 'error')) {
      throw new Error('refresh failed')
    }
  })

  console.log(summary('refresh', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})

// The browser client type adds an Origin check, a cookie read and a Set-Cookie to the same path;
// all are string work, so the same budget applies.
test(`refresh with the cookie: the best of ${BATCHES} batches of ${BATCH_REQUESTS} is within ${BUDGET_MS} ms`, async () => {
  const origin = 'https://app.example.com'
  const deps = await createReadyDeps({ env: { SESSION_ALLOWED_ORIGINS: origin } })
  const app = createApp(deps)
  const email = 'bench@northline.app'
  const started = await call(app, 'POST', '/v1/client/sign-ups', {
    client: 'browser',
    body: { email, password: 'correct horse battery', organizationName: 'Northline' },
  })
  const done = await call(
    app,
    'POST',
    `/v1/client/sign-ups/${text(started.body, 'id')}/verify-email`,
    {
      client: 'browser',
      attempt: text(started.body, 'attemptSecret'),
      body: { code: emailedCode(deps, email) },
    }
  )
  let cookie = (done.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''

  const result = await measure(async () => {
    const next = await call(app, 'POST', '/v1/client/sessions/refresh', {
      client: 'browser',
      headers: { origin, cookie },
    })
    cookie = (next.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
    deps.clock.advance('1s')
    if (at(next.body, 'error') || cookie === '') {
      throw new Error('refresh failed')
    }
  })

  console.log(summary('refresh (cookie)', result))
  expect(result.bestMs).toBeLessThan(BUDGET_MS)
})
