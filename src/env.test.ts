import { describe, expect, test } from 'bun:test'
import {
  allowedOrigins,
  counterHashKey,
  databaseUrl,
  deviceCookieKey,
  googleConfig,
  LOCAL_COUNTER_HASH_KEY,
  LOCAL_DEVICE_COOKIE_KEY,
  LOCAL_MASTER_KEY,
  loadEnv,
  masterKey,
  publicUrl,
  sessionCookieInsecure,
  trustedProxyHops,
} from './env'

test('configuration falls back to defaults for everything but the environment', () => {
  expect(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })).toEqual({
    ENVIRONMENT: 'local',
    REGION: 'us',
    TOKEN_AUDIENCE: 'closeline',
    PORT: 3000,
    LOG_LEVEL: 'info',
    READINESS_TIMEOUT_MS: 2_000,
    SHUTDOWN_TIMEOUT_MS: 10_000,
    SHUTDOWN_GRACE_MS: 5_000,
    MAX_REQUEST_BODY_BYTES: 1_048_576,
    DB_POOL_MAX: 10,
    RETENTION_INTERVAL_MS: 600_000,
    RETENTION_BATCH_SIZE: 500,
    RETENTION_RUN_TIMEOUT_MS: 30_000,
    ABANDON_SWEEP_INTERVAL_MS: 60_000,
    ABANDON_SWEEP_BATCH_SIZE: 10,
    HASH_CONCURRENCY: 4,
    HASH_QUEUE: 16,
    SIGN_IN_CONCURRENCY: 4,
    SIGN_IN_QUEUE: 16,
    BREACH_CHECK_CONCURRENCY: 8,
    BREACH_CHECK_QUEUE: 16,
    CORE_CONCURRENCY: 64,
    CORE_QUEUE: 256,
  })
})

test('a deploy without ENVIRONMENT fails at boot instead of running as local', () => {
  expect(() => loadEnv({})).toThrow()
})

test.each([
  ['an unknown environment', { ENVIRONMENT: 'production' }],
  ['an unknown log level', { LOG_LEVEL: 'verbose' }],
  ['a port out of range', { PORT: '70000' }],
  ['a zero readiness timeout', { READINESS_TIMEOUT_MS: '0' }],
  ['a non-numeric shutdown timeout', { SHUTDOWN_TIMEOUT_MS: 'soon' }],
  ['a negative shutdown grace', { SHUTDOWN_GRACE_MS: '-1' }],
  ['a zero body limit', { MAX_REQUEST_BODY_BYTES: '0' }],
  ['a body limit above 100 MB', { MAX_REQUEST_BODY_BYTES: '104857601' }],
  ['an empty connection pool', { DB_POOL_MAX: '0' }],
  ['a pool too small for the purge and a request (3)', { DB_POOL_MAX: '3' }],
  ['a pool above 100 connections', { DB_POOL_MAX: '101' }],
  ['a purge interval of zero', { RETENTION_INTERVAL_MS: '0' }],
  ['a purge batch above 5000', { RETENTION_BATCH_SIZE: '5001' }],
  ['a purge run timeout of zero', { RETENTION_RUN_TIMEOUT_MS: '0' }],
  ['a sweep batch of zero', { ABANDON_SWEEP_BATCH_SIZE: '0' }],
  ['a sweep interval of zero', { ABANDON_SWEEP_INTERVAL_MS: '0' }],
  ['no hash slots', { HASH_CONCURRENCY: '0' }],
  ['a negative hash queue', { HASH_QUEUE: '-1' }],
  ['no sign-in slots', { SIGN_IN_CONCURRENCY: '0' }],
  ['a sign-in queue above 1000', { SIGN_IN_QUEUE: '1001' }],
  ['no breach lookup slots', { BREACH_CHECK_CONCURRENCY: '0' }],
  ['a breach queue above 1000', { BREACH_CHECK_QUEUE: '1001' }],
  ['no slots for calls to core', { CORE_CONCURRENCY: '0' }],
  ['more than 1000 calls to core at once', { CORE_CONCURRENCY: '1001' }],
  ['a negative queue for calls to core', { CORE_QUEUE: '-1' }],
  ['a core queue above 10000', { CORE_QUEUE: '10001' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', REGION: 'us', ...source })).toThrow()
})

test('a grace period plus drain timeout above 60 s is rejected, naming both keys', () => {
  const source = {
    ENVIRONMENT: 'local',
    REGION: 'us',
    SHUTDOWN_GRACE_MS: '30001',
    SHUTDOWN_TIMEOUT_MS: '30000',
  }

  expect(() => loadEnv(source)).toThrow(/SHUTDOWN_GRACE_MS.*SHUTDOWN_TIMEOUT_MS/s)
})

test('a grace period plus drain timeout of exactly 60 s is accepted', () => {
  const env = loadEnv({
    ENVIRONMENT: 'local',
    REGION: 'us',
    SHUTDOWN_GRACE_MS: '30000',
    SHUTDOWN_TIMEOUT_MS: '30000',
  })

  expect(env.SHUTDOWN_GRACE_MS + env.SHUTDOWN_TIMEOUT_MS).toBe(60_000)
})

test('a deploy outside local must set the database, the master key, the public URL and core', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'prod', REGION: 'us' })).toThrow(
    /DATABASE_URL.*AUTH_MASTER_KEY.*PUBLIC_URL.*CORE_BASE_URL.*CORE_INTERNAL_TOKEN/s
  )
})

const DEPLOYED = {
  ENVIRONMENT: 'prod',
  REGION: 'eu',
  DATABASE_URL: 'postgres://closeline_auth:x@db/closeline',
  AUTH_MASTER_KEY: 'ab'.repeat(32),
  PUBLIC_URL: 'https://auth.eu.example.com/',
  CORE_BASE_URL: 'https://core.eu.internal.example.com',
  CORE_INTERNAL_TOKEN: 'c'.repeat(32),
  SESSION_ALLOWED_ORIGINS: 'https://app.example.com',
  COUNTER_HASH_KEY: 'h'.repeat(40),
  DEVICE_COOKIE_KEY: 'd'.repeat(40),
  TRUSTED_PROXY_HOPS: '1',
}

test('a deploy outside local boots with everything set', () => {
  const env = loadEnv(DEPLOYED)

  expect(publicUrl(env)).toBe('https://auth.eu.example.com')
  expect(masterKey(env)).toBe('ab'.repeat(32))
})

test.each([
  ['a master key that is not hex', { AUTH_MASTER_KEY: 'z'.repeat(64) }],
  ['a master key of the wrong length', { AUTH_MASTER_KEY: 'ab'.repeat(31) }],
  ['an unknown Region', { REGION: 'asia' }],
  ['a public URL that is not a URL', { PUBLIC_URL: 'auth' }],
])('configuration rejects %s at boot', (_name, source) => {
  expect(() => loadEnv({ ENVIRONMENT: 'local', REGION: 'us', ...source })).toThrow()
})

test('a deploy with no Region fails at boot', () => {
  expect(() => loadEnv({ ENVIRONMENT: 'local' })).toThrow(/REGION/)
})

test('local falls back to the development key and the compose database, and nowhere else', () => {
  const env = loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })

  expect(masterKey(env)).toBe(LOCAL_MASTER_KEY)
  expect(databaseUrl(env, { POSTGRES_PORT: '5434' })).toContain('127.0.0.1:5434/closeline')
  expect(publicUrl(env)).toBe('http://localhost:3000')
})

describe('the core service settings', () => {
  const LOCAL = { ENVIRONMENT: 'local', REGION: 'us' }

  test('local runs without core (the placeholder), or with both settings, over http', () => {
    expect(loadEnv(LOCAL).CORE_BASE_URL).toBeUndefined()
    expect(
      loadEnv({
        ...LOCAL,
        CORE_BASE_URL: 'http://127.0.0.1:3100',
        CORE_INTERNAL_TOKEN: 'x'.repeat(32),
      }).CORE_BASE_URL
    ).toBe('http://127.0.0.1:3100')
  })

  test.each([
    ['a URL without its token', { CORE_BASE_URL: 'http://127.0.0.1:3100' }],
    ['a token without its URL', { CORE_INTERNAL_TOKEN: 'x'.repeat(32) }],
  ])(
    'local refuses %s: half a setting would fall back to the placeholder unseen',
    (_name, source) => {
      expect(() => loadEnv({ ...LOCAL, ...source })).toThrow(/CORE_/)
    }
  )

  test.each([
    ['plain http', { CORE_BASE_URL: 'http://core.example.com' }],
    ['a URL with credentials', { CORE_BASE_URL: 'https://user:pw@core.example.com' }],
    ['a URL with a query', { CORE_BASE_URL: 'https://core.example.com/?a=1' }],
    ['a URL that is not http', { CORE_BASE_URL: 'ftp://core.example.com' }],
    ['a token of 31 characters', { CORE_INTERNAL_TOKEN: 'c'.repeat(31) }],
    ['a token with a space', { CORE_INTERNAL_TOKEN: `${'c'.repeat(32)} x` }],
    ['no URL', { CORE_BASE_URL: undefined }],
    ['no token', { CORE_INTERNAL_TOKEN: undefined }],
  ])('a deployment outside local refuses %s', (_name, source) => {
    expect(() => loadEnv({ ...DEPLOYED, ...source })).toThrow()
  })

  test.each([
    'https://core.example.com/#',
    'https://core.example.com/?',
    'https://core.example.com?',
  ])('a base URL ending in a bare # or ? (%s) is reported as a CORE_BASE_URL issue', (url) => {
    const result = envSchemaIssues({ ...DEPLOYED, CORE_BASE_URL: url })

    expect(result).toContain('CORE_BASE_URL')
  })

  test('a refused token is never echoed in the error', () => {
    const secret = 'Sup3rSecret-but-with a space-inside-it'

    let message = ''
    try {
      loadEnv({ ...DEPLOYED, CORE_INTERNAL_TOKEN: secret })
    } catch (error) {
      message = String(error instanceof Error ? error.message : error)
    }

    expect(message).toContain('CORE_INTERNAL_TOKEN')
    expect(message).not.toContain('Sup3rSecret')
  })
})

describe('the local mail settings', () => {
  const LOCAL = { ENVIRONMENT: 'local', REGION: 'us' }
  const message = (source: Record<string, string | undefined>) => {
    try {
      loadEnv(source)
    } catch (error) {
      return String(error instanceof Error ? error.message : error)
    }
    return ''
  }

  test.each([
    ['http://127.0.0.1:8025', 'http://127.0.0.1:8025'],
    ['http://127.0.0.1:8025/', 'http://127.0.0.1:8025'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
    ['http://localhost:8025', 'http://localhost:8025'],
    ['http://[::1]:8025', 'http://[::1]:8025'],
    ['http://[::1]/', 'http://[::1]'],
    ['http://LOCALHOST', 'http://localhost'],
    ['http://LocalHost:1/', 'http://localhost:1'],
    ['http://127.0.0.1:65535', 'http://127.0.0.1:65535'],
  ])('local accepts the mailbox at %s and keeps the canonical origin', (url, canonical) => {
    expect(loadEnv({ ...LOCAL, MAIL_LOCAL_URL: url }).MAIL_LOCAL_URL).toBe(canonical)
  })

  test('local runs with neither mail setting, and accepts a sender under .test', () => {
    const env = loadEnv(LOCAL)

    expect(env.MAIL_LOCAL_URL).toBeUndefined()
    expect(env.MAIL_LOCAL_FROM).toBeUndefined()
    expect(
      loadEnv({ ...LOCAL, MAIL_LOCAL_URL: 'http://127.0.0.1:8025', MAIL_LOCAL_FROM: 'a@b.test' })
        .MAIL_LOCAL_FROM
    ).toBe('a@b.test')
  })

  test.each([
    ['a non-loopback host', 'http://mail.example.com:8025'],
    ['a private address', 'http://192.168.1.5:8025'],
    ['a public address', 'http://8.8.8.8:8025'],
    ['a host that only starts like localhost', 'http://localhost.evil.example:8025'],
    ['a host hidden behind credentials', 'http://127.0.0.1@evil.example:8025'],
    ['https', 'https://127.0.0.1:8025'],
    ['another scheme', 'ftp://127.0.0.1'],
    ['credentials', 'http://user:pw@127.0.0.1:8025'],
    ['a username alone', 'http://user@127.0.0.1:8025'],
    ['a path', 'http://127.0.0.1:8025/api'],
    ['a trailing path after a slash', 'http://127.0.0.1:8025//'],
    ['a query', 'http://127.0.0.1:8025/?a=1'],
    ['an empty query', 'http://127.0.0.1:8025?'],
    ['a fragment', 'http://127.0.0.1:8025/#x'],
    ['no URL at all', 'not a url'],
    ['an empty value', ''],
    ['the unspecified address', 'http://0.0.0.0'],
    ['the unspecified address with a port', 'http://0.0.0.0:8025'],
    ['a short IPv4 form', 'http://127.1'],
    ['a decimal IPv4 form', 'http://2130706433'],
    ['a hexadecimal IPv4 form', 'http://0x7f.0.0.1'],
    ['an octal IPv4 form', 'http://0177.0.0.1'],
    ['a padded IPv4 form', 'http://127.000.000.1'],
    ['a long IPv6 form', 'http://[0:0:0:0:0:0:0:1]:8025'],
    ['an absolute host name', 'http://127.0.0.1.'],
    ['an absolute localhost', 'http://localhost.:8025'],
    ['a scheme without slashes', 'http:localhost'],
    ['an upper-case scheme', 'HTTP://localhost:8025'],
    ['a backslash form', 'http:\\\\localhost'],
    ['a leading space', ' http://localhost:8025'],
    ['a trailing space', 'http://localhost:8025 '],
    ['a trailing newline', 'http://localhost:8025\n'],
    ['a full-width host', 'http://ｌｏｃａｌｈｏｓｔ:8025'],
    ['port 0', 'http://127.0.0.1:0'],
    ['a port above 65535', 'http://127.0.0.1:65536'],
    ['a zero-padded port', 'http://127.0.0.1:08025'],
    ['an empty port', 'http://127.0.0.1:'],
  ])('local refuses %s', (_name, url) => {
    expect(() => loadEnv({ ...LOCAL, MAIL_LOCAL_URL: url })).toThrow(/MAIL_LOCAL_URL/)
  })

  test.each(['dev', 'staging', 'prod'])(
    '%s refuses the setting even for a loopback address',
    (environment) => {
      const source = { ...DEPLOYED, ENVIRONMENT: environment }

      expect(() => loadEnv({ ...source, MAIL_LOCAL_URL: 'http://127.0.0.1:8025' })).toThrow(
        /MAIL_LOCAL_URL/
      )
      expect(() => loadEnv({ ...source, MAIL_LOCAL_FROM: 'a@b.test' })).toThrow(/MAIL_LOCAL_FROM/)
    }
  )

  test('a deploy outside local still boots without the settings', () => {
    expect(loadEnv(DEPLOYED).MAIL_LOCAL_URL).toBeUndefined()
  })

  test.each([
    ['a sender that is not an address', 'not-an-address'],
    ['a sender with a display name', 'Closeline <a@b.test>'],
  ])('local refuses %s', (_name, from) => {
    expect(() =>
      loadEnv({ ...LOCAL, MAIL_LOCAL_URL: 'http://127.0.0.1:8025', MAIL_LOCAL_FROM: from })
    ).toThrow(/MAIL_LOCAL_FROM/)
  })

  test.each([
    [
      'a host that is refused',
      { ENVIRONMENT: 'local', MAIL_LOCAL_URL: 'http://token-9d2@evil.example:8025' },
    ],
    [
      'a deployment that is refused',
      { ...DEPLOYED, MAIL_LOCAL_URL: 'http://secret-host-9d2.example:8025' },
    ],
  ])('the message for %s does not print the value', (_name, extra) => {
    const text = message({ REGION: 'us', ...extra })

    expect(text).toContain('MAIL_LOCAL_URL')
    expect(text).not.toContain('9d2')
    expect(text).not.toContain('evil')
  })
})

describe('the browser session settings', () => {
  const deployed = {
    ENVIRONMENT: 'prod',
    REGION: 'us',
    DATABASE_URL: 'postgres://u:p@db.example.com/closeline',
    AUTH_MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'https://auth.example.com',
    CORE_BASE_URL: 'https://core.example.com',
    CORE_INTERNAL_TOKEN: 'x'.repeat(40),
    SESSION_ALLOWED_ORIGINS: 'https://app.example.com',
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
    TRUSTED_PROXY_HOPS: '1',
  }

  test('both are unset by default: secure cookie, and no origin is allowed', () => {
    const env = loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })

    expect(env.SESSION_COOKIE_INSECURE).toBeUndefined()
    expect(env.SESSION_ALLOWED_ORIGINS).toBeUndefined()
    expect(sessionCookieInsecure(env)).toBe(false)
    expect(allowedOrigins(env)).toEqual([])
  })

  test('the insecure cookie is accepted in local only', () => {
    expect(
      sessionCookieInsecure(
        loadEnv({ ENVIRONMENT: 'local', REGION: 'us', SESSION_COOKIE_INSECURE: 'true' })
      )
    ).toBe(true)
    for (const environment of ['dev', 'staging', 'prod']) {
      expect(() =>
        loadEnv({ ...deployed, ENVIRONMENT: environment, SESSION_COOKIE_INSECURE: 'true' })
      ).toThrow(/SESSION_COOKIE_INSECURE/)
      expect(
        sessionCookieInsecure(
          loadEnv({ ...deployed, ENVIRONMENT: environment, SESSION_COOKIE_INSECURE: 'false' })
        )
      ).toBe(false)
    }
  })

  test.each(['yes', '1', 'TRUE', ''])('the insecure cookie refuses %p', (value) => {
    expect(() =>
      loadEnv({ ENVIRONMENT: 'local', REGION: 'us', SESSION_COOKIE_INSECURE: value })
    ).toThrow(/SESSION_COOKIE_INSECURE/)
  })

  test('allowed origins are a list of exact https origins', () => {
    const env = loadEnv({
      ...deployed,
      SESSION_ALLOWED_ORIGINS: 'https://app.example.com, https://portal.example.com:8443',
    })

    expect(allowedOrigins(env)).toEqual([
      'https://app.example.com',
      'https://portal.example.com:8443',
    ])
  })

  test.each([['dev'], ['staging'], ['prod']])('%s refuses an http origin', (environment) => {
    expect(() =>
      loadEnv({
        ...deployed,
        ENVIRONMENT: environment,
        SESSION_ALLOWED_ORIGINS: 'http://app.example.com',
      })
    ).toThrow(/SESSION_ALLOWED_ORIGINS/)
  })

  test('local accepts http and https origins', () => {
    const env = loadEnv({
      ENVIRONMENT: 'local',
      REGION: 'us',
      SESSION_ALLOWED_ORIGINS: 'http://localhost:5173,https://localhost:5174',
    })

    expect(allowedOrigins(env)).toEqual(['http://localhost:5173', 'https://localhost:5174'])
  })

  test.each([
    ['a bare wildcard', '*'],
    ['a wildcard subdomain', 'https://*.example.com'],
    ['a wildcard among others', 'https://app.example.com,*'],
    ['null', 'null'],
    ['a trailing slash', 'https://app.example.com/'],
    ['a path', 'https://app.example.com/portal'],
    ['a query', 'https://app.example.com?x=1'],
    ['credentials', 'https://user:pass@app.example.com'],
    ['no scheme', 'app.example.com'],
    ['another scheme', 'ftp://app.example.com'],
    ['an empty entry', 'https://app.example.com,,https://b.example.com'],
    ['a blank value', ''],
    ['an upper-case host', 'https://APP.example.com'],
    ['the default port spelled out', 'https://app.example.com:443'],
  ])('allowed origins refuse %s', (_name, value) => {
    expect(() => loadEnv({ ...deployed, SESSION_ALLOWED_ORIGINS: value })).toThrow(
      /SESSION_ALLOWED_ORIGINS/
    )
    expect(() =>
      loadEnv({ ENVIRONMENT: 'local', REGION: 'us', SESSION_ALLOWED_ORIGINS: value })
    ).toThrow(/SESSION_ALLOWED_ORIGINS/)
  })

  test('the error names the key and never echoes the value', () => {
    let message = ''
    try {
      loadEnv({ ...deployed, SESSION_ALLOWED_ORIGINS: 'http://secret-host.example.com' })
    } catch (error) {
      message = String(error)
    }

    expect(message).toContain('SESSION_ALLOWED_ORIGINS')
    expect(message).not.toContain('secret-host')
  })

  test('more than twenty origins are refused', () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://a${i}.example.com`).join(',')

    expect(() => loadEnv({ ...deployed, SESSION_ALLOWED_ORIGINS: many })).toThrow(
      /SESSION_ALLOWED_ORIGINS/
    )
  })

  test('duplicate origins are refused', () => {
    for (const value of [
      'https://app.example.com,https://app.example.com',
      'https://app.example.com, https://app.example.com',
    ]) {
      expect(() => loadEnv({ ...deployed, SESSION_ALLOWED_ORIGINS: value })).toThrow(
        /SESSION_ALLOWED_ORIGINS/
      )
    }
  })

  test.each(['dev', 'staging', 'prod'])(
    '%s refuses to boot with no allowed origin',
    (environment) => {
      const { SESSION_ALLOWED_ORIGINS: _unset, ...without } = deployed
      expect(() => loadEnv({ ...without, ENVIRONMENT: environment })).toThrow(
        /SESSION_ALLOWED_ORIGINS/
      )
      expect(() =>
        loadEnv({ ...without, ENVIRONMENT: environment, SESSION_ALLOWED_ORIGINS: '' })
      ).toThrow(/SESSION_ALLOWED_ORIGINS/)
    }
  )
})

/** The paths of the issues `loadEnv` reports for `source`, as one string. */
function envSchemaIssues(source: Record<string, string | undefined>): string {
  try {
    loadEnv(source)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

describe('the counter hash key and the known-device cookie key', () => {
  const { COUNTER_HASH_KEY, DEVICE_COOKIE_KEY, ...withoutKeys } = {
    ...DEPLOYED,
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
    TRUSTED_PROXY_HOPS: '1',
  }

  test.each(['dev', 'staging', 'prod'])(
    'both are required in %s, and the message names them',
    (environment) => {
      const message = (() => {
        try {
          loadEnv({ ...withoutKeys, ENVIRONMENT: environment })
          return ''
        } catch (error) {
          return String(error)
        }
      })()

      expect(message).toContain('COUNTER_HASH_KEY is required outside local')
      expect(message).toContain('DEVICE_COOKIE_KEY is required outside local')
    }
  )

  test.each([
    ['COUNTER_HASH_KEY', { COUNTER_HASH_KEY }],
    ['DEVICE_COOKIE_KEY', { DEVICE_COOKIE_KEY }],
  ])('a deploy with only %s still fails at boot', (_name, only) => {
    expect(() => loadEnv({ ...withoutKeys, ...only })).toThrow(/is required outside local/)
  })

  test('a deploy with both boots, and the settings are the ones given', () => {
    const env = loadEnv({ ...withoutKeys, COUNTER_HASH_KEY, DEVICE_COOKIE_KEY })

    expect(counterHashKey(env)).toBe(COUNTER_HASH_KEY)
    expect(deviceCookieKey(env)).toBe(DEVICE_COOKIE_KEY)
  })

  test.each([
    ['too short', 'short'],
    ['31 characters', 'x'.repeat(31)],
    ['longer than 512', 'x'.repeat(513)],
    ['with a space', `${'x'.repeat(40)} y`],
    ['empty', ''],
  ])('a key that is %s is refused, in local too', (_name, value) => {
    for (const key of ['COUNTER_HASH_KEY', 'DEVICE_COOKIE_KEY']) {
      expect(() => loadEnv({ ENVIRONMENT: 'local', REGION: 'us', [key]: value })).toThrow(
        new RegExp(key)
      )
    }
  })

  test('the two keys must differ', () => {
    expect(() =>
      loadEnv({ ...withoutKeys, COUNTER_HASH_KEY, DEVICE_COOKIE_KEY: COUNTER_HASH_KEY })
    ).toThrow(/DEVICE_COOKIE_KEY must differ/)
  })

  test('the message never carries the value', () => {
    const secret = 'secret-value-that-is-too-short'
    let message = ''
    try {
      loadEnv({ ENVIRONMENT: 'local', REGION: 'us', COUNTER_HASH_KEY: secret.slice(0, 20) })
    } catch (error) {
      message = String(error)
    }

    expect(message).toContain('COUNTER_HASH_KEY')
    expect(message).not.toContain(secret.slice(0, 20))
  })

  test('local falls back to fixed development keys that differ from each other, and nowhere else', () => {
    const env = loadEnv({ ENVIRONMENT: 'local', REGION: 'us' })

    expect(counterHashKey(env)).toBe(LOCAL_COUNTER_HASH_KEY)
    expect(deviceCookieKey(env)).toBe(LOCAL_DEVICE_COOKIE_KEY)
    expect(LOCAL_COUNTER_HASH_KEY).not.toBe(LOCAL_DEVICE_COOKIE_KEY)
    expect(LOCAL_COUNTER_HASH_KEY.length).toBeGreaterThanOrEqual(32)
    expect(() => loadEnv({ ...withoutKeys })).toThrow()
  })
})

describe('the published development keys', () => {
  const deployed = {
    ...DEPLOYED,
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
    TRUSTED_PROXY_HOPS: '1',
  }

  test.each([
    ['AUTH_MASTER_KEY', LOCAL_MASTER_KEY],
    ['AUTH_MASTER_KEY', LOCAL_MASTER_KEY.toUpperCase()],
    ['COUNTER_HASH_KEY', LOCAL_COUNTER_HASH_KEY],
    ['DEVICE_COOKIE_KEY', LOCAL_DEVICE_COOKIE_KEY],
  ])(
    '%s equal to its local default fails to load in prod, naming the setting only',
    (key, value) => {
      let message = ''
      try {
        loadEnv({ ...deployed, [key]: value })
      } catch (error) {
        message = String(error)
      }

      expect(message).toContain(`${key} must not be the published development key`)
      expect(message).not.toContain(value)
    }
  )

  test('the same values are accepted in local', () => {
    expect(() =>
      loadEnv({
        ENVIRONMENT: 'local',
        REGION: 'us',
        AUTH_MASTER_KEY: LOCAL_MASTER_KEY,
        COUNTER_HASH_KEY: LOCAL_COUNTER_HASH_KEY,
        DEVICE_COOKIE_KEY: LOCAL_DEVICE_COOKIE_KEY,
      })
    ).not.toThrow()
  })
})

describe('the Sign in with Google settings', () => {
  const deployed = {
    ENVIRONMENT: 'prod',
    REGION: 'eu',
    DATABASE_URL: 'postgres://closeline_auth:x@db.example.com/closeline',
    AUTH_MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'https://auth.example.com',
    CORE_BASE_URL: 'https://core.example.com',
    CORE_INTERNAL_TOKEN: 'c'.repeat(40),
    SESSION_ALLOWED_ORIGINS: 'https://app.example.com',
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
    TRUSTED_PROXY_HOPS: '1',
  }
  const google = {
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'super-secret-value',
    GOOGLE_REDIRECT_URI: 'https://app.example.com/v1/client/google/callback',
  }

  test('none set means off', () => {
    expect(googleConfig(loadEnv(deployed))).toBeUndefined()
    expect(googleConfig(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }))).toBeUndefined()
  })

  test('all three set means on, with Google as the issuer', () => {
    expect(googleConfig(loadEnv({ ...deployed, ...google }))).toEqual({
      clientId: 'client-id',
      clientSecret: 'super-secret-value',
      redirectUri: 'https://app.example.com/v1/client/google/callback',
      issuer: 'https://accounts.google.com',
    })
  })

  test.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const)(
    'a half-set configuration without %s fails at boot, in every environment',
    (missing) => {
      const { [missing]: _removed, ...partial } = google
      for (const base of [deployed, { ENVIRONMENT: 'local', REGION: 'us' }]) {
        expect(() => loadEnv({ ...base, ...partial })).toThrow(missing)
      }
    }
  )

  test('a failure never repeats the secret or the URL', () => {
    const attempt = () =>
      loadEnv({ ...deployed, ...google, GOOGLE_REDIRECT_URI: 'http://app.example.com/wrong' })
    expect(attempt).toThrow()
    try {
      attempt()
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-value')
      expect(String(error)).not.toContain('http://app.example.com/wrong')
    }
  })

  test.each([
    ['http outside local', 'http://app.example.com/v1/client/google/callback'],
    ['an origin that is not allowed', 'https://other.example.com/v1/client/google/callback'],
    ['another path', 'https://app.example.com/callback'],
    ['a query', 'https://app.example.com/v1/client/google/callback?x=1'],
    ['not a URL', 'nonsense'],
  ])('refuses a redirect URI with %s outside local', (_name, uri) => {
    expect(() => loadEnv({ ...deployed, ...google, GOOGLE_REDIRECT_URI: uri })).toThrow(
      'GOOGLE_REDIRECT_URI'
    )
  })

  test('local accepts http and any origin, but still the callback path', () => {
    const local = { ENVIRONMENT: 'local', REGION: 'us', ...google }
    expect(
      googleConfig(
        loadEnv({
          ...local,
          GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3002/v1/client/google/callback',
        })
      )?.redirectUri
    ).toBe('http://127.0.0.1:3002/v1/client/google/callback')
    expect(() => loadEnv({ ...local, GOOGLE_REDIRECT_URI: 'http://127.0.0.1:3002/x' })).toThrow(
      'GOOGLE_REDIRECT_URI'
    )
  })

  test('the issuer override is local only and needs the other three', () => {
    const local = { ENVIRONMENT: 'local', REGION: 'us' }
    const issuer = 'http://127.0.0.1:4010'
    expect(
      googleConfig(loadEnv({ ...local, ...google, GOOGLE_ISSUER_URL: `${issuer}/` }))?.issuer
    ).toBe(issuer)
    expect(() => loadEnv({ ...local, GOOGLE_ISSUER_URL: issuer })).toThrow('GOOGLE_ISSUER_URL')
    expect(() => loadEnv({ ...deployed, ...google, GOOGLE_ISSUER_URL: issuer })).toThrow(
      'GOOGLE_ISSUER_URL'
    )
    expect(() => loadEnv({ ...local, ...google, GOOGLE_ISSUER_URL: 'ftp://x' })).toThrow(
      'GOOGLE_ISSUER_URL'
    )
  })
})

describe('the trusted proxy hops', () => {
  test('default to one, and are an integer from 1 to 10', () => {
    expect(trustedProxyHops(loadEnv({ ENVIRONMENT: 'local', REGION: 'us' }))).toBe(1)
    expect(
      trustedProxyHops(loadEnv({ ENVIRONMENT: 'local', REGION: 'us', TRUSTED_PROXY_HOPS: '2' }))
    ).toBe(2)
    for (const value of ['0', '11', '1.5', 'two', '']) {
      expect(() =>
        loadEnv({ ENVIRONMENT: 'local', REGION: 'us', TRUSTED_PROXY_HOPS: value })
      ).toThrow('TRUSTED_PROXY_HOPS')
    }
  })
})

describe('the trusted proxy hops outside local', () => {
  const deployed = {
    ENVIRONMENT: 'prod',
    REGION: 'eu',
    DATABASE_URL: 'postgres://closeline_auth:x@db.example.com/closeline',
    AUTH_MASTER_KEY: 'ab'.repeat(32),
    PUBLIC_URL: 'https://auth.example.com',
    CORE_BASE_URL: 'https://core.example.com',
    CORE_INTERNAL_TOKEN: 'c'.repeat(40),
    SESSION_ALLOWED_ORIGINS: 'https://app.example.com',
    COUNTER_HASH_KEY: 'h'.repeat(40),
    DEVICE_COOKIE_KEY: 'd'.repeat(40),
  }

  test.each(['dev', 'staging', 'prod'])(
    '%s fails at boot without TRUSTED_PROXY_HOPS',
    (environment) => {
      expect(() => loadEnv({ ...deployed, ENVIRONMENT: environment })).toThrow('TRUSTED_PROXY_HOPS')
      expect(
        trustedProxyHops(
          loadEnv({ ...deployed, ENVIRONMENT: environment, TRUSTED_PROXY_HOPS: '2' })
        )
      ).toBe(2)
    }
  )
})
