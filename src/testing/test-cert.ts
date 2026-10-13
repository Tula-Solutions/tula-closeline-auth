import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A throwaway self-signed certificate for 127.0.0.1, in a temporary folder that `remove` deletes. */
export type TestCert = { cert: string; key: string; remove: () => void }

/**
 * Makes a two-day certificate with `openssl` for tests and benchmarks that need a TLS stand-in
 * for core. Returns `undefined` when `openssl` cannot (nothing is left behind).
 */
export function makeTestCert(): TestCert | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'auth-tls-'))
  const remove = () => rmSync(dir, { recursive: true, force: true })
  try {
    const made = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      join(dir, 'key'),
      '-out',
      join(dir, 'cert'),
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ])
    if (made.exitCode !== 0) {
      remove()
      return undefined
    }
    return {
      cert: readFileSync(join(dir, 'cert'), 'utf8'),
      key: readFileSync(join(dir, 'key'), 'utf8'),
      remove,
    }
  } catch {
    remove()
    return undefined
  }
}
