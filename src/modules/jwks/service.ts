import { createStaticKeySet, MAX_JWKS_KEYS } from 'tula-closeline-kit'
import type { Container } from '~/container'
import { ACCESS_TOKEN_ALGORITHM, type Jwk, type Jwks } from '~/modules/jwks/schema'
import type { Tenant } from '~/ports/fixed-project'
import type { NewSigningKey, SigningKeyStatus } from '~/ports/signing-key-store'

/** Secret-box purpose for signing keys; separates their encryption key from other secrets. */
export const SECRET_BOX_PURPOSE = 'signing-keys'

/**
 * How long a `next` key must be published before rotation may activate it. The kit's rule is
 * five minutes; this must also exceed the JWKS `max-age` so every verifier has seen the key
 * before it signs anything.
 */
export const NEXT_KEY_MIN_AGE_MS = 10 * 60_000

/** `Cache-Control: max-age` of the public JWKS, in seconds. See {@link NEXT_KEY_MIN_AGE_MS}. */
export const JWKS_MAX_AGE_SECONDS = 300

/** What key handling needs from the container. */
export type KeyDeps = Pick<Container, 'signingKeys' | 'secretBox' | 'ids' | 'clock'>

/**
 * Associated data that binds a sealed private key to its row, so a ciphertext copied into another
 * key or environment fails to decrypt.
 */
export function ciphertextAad(keyId: string, environmentId: string): string {
  return `signing-key:${keyId}:environment:${environmentId}`
}

async function generate(
  deps: Pick<KeyDeps, 'secretBox' | 'ids'>,
  tenant: Tenant,
  status: Exclude<SigningKeyStatus, 'retired'>,
  now: Date
): Promise<NewSigningKey> {
  const id = deps.ids.next()
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  // WebCrypto's typings return a union; asymmetric algorithms always produce a pair.
  if (!('privateKey' in pair)) {
    throw new Error('Ed25519 generateKey did not return a key pair')
  }
  const [pkcs8, publicJwk] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
    crypto.subtle.exportKey('jwk', pair.publicKey),
  ])
  // Built field by field so nothing private (`d`) can ever slip into the public key.
  const jwk: Jwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: String(publicJwk.x),
    kid: id,
    alg: ACCESS_TOKEN_ALGORITHM,
    use: 'sig',
  }
  return {
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    status,
    publicJwk: jwk,
    privateKeyCiphertext: await deps.secretBox.seal(
      SECRET_BOX_PURPOSE,
      new Uint8Array(pkcs8),
      ciphertextAad(id, tenant.environmentId)
    ),
    createdAt: now,
    activatedAt: status === 'active' ? now : null,
  }
}

/**
 * Make sure the environment has an `active` and a `next` key, creating whichever is missing.
 *
 * Safe to run concurrently on many instances: the store allows one key per slot, so racing
 * writers lose quietly and the winner's keys are used. The very first `active` key is published
 * in the same insert that creates it, before any token can be signed with it, so no verifier
 * ever holds a key set that lacks it.
 */
export async function ensureKeys(deps: KeyDeps, tenant: Tenant): Promise<void> {
  const keys = await deps.signingKeys.list(tenant.environmentId)
  const missing = (['active', 'next'] as const).filter(
    (status) => !keys.some((key) => key.status === status)
  )
  if (missing.length === 0) {
    return
  }
  const now = deps.clock.now()
  const created = await Promise.all(missing.map((status) => generate(deps, tenant, status, now)))
  await deps.signingKeys.insert(tenant.environmentId, created)
}

// The imported private key of each environment's active key, by AAD and ciphertext: a hit means
// this exact binding already decrypted successfully, so a ciphertext copied into another row still
// has to pass the AAD check. One entry per environment, so a rotated-out key is dropped.
const privateKeys = new Map<string, { cacheKey: string; key: Promise<CryptoKey> }>()

/**
 * The key to sign access tokens with, creating keys on first use.
 *
 * The private key is decrypted once per kid and held as a non-extractable `CryptoKey`.
 *
 * @throws Error if no key can be established or the master key does not open the stored one.
 */
export async function activeSigningKey(
  deps: KeyDeps,
  tenant: Tenant
): Promise<{ kid: string; privateKey: CryptoKey }> {
  const find = () => deps.signingKeys.active(tenant.environmentId)
  let active = await find()
  if (!active) {
    await ensureKeys(deps, tenant)
    active = await find()
  }
  if (!active) {
    throw new Error('no active signing key after bootstrap')
  }
  const { id, privateKeyCiphertext } = active
  const aad = ciphertextAad(id, tenant.environmentId)
  const cacheKey = `${aad}:${privateKeyCiphertext}`
  let privateKey = privateKeys.get(tenant.environmentId)?.key
  if (privateKeys.get(tenant.environmentId)?.cacheKey !== cacheKey) {
    privateKey = deps.secretBox
      .open(SECRET_BOX_PURPOSE, privateKeyCiphertext, aad)
      .then((pkcs8) =>
        crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8), { name: 'Ed25519' }, false, [
          'sign',
        ])
      )
    const entry = { cacheKey, key: privateKey }
    privateKeys.set(tenant.environmentId, entry)
    privateKey.catch(() => {
      if (privateKeys.get(tenant.environmentId) === entry) {
        privateKeys.delete(tenant.environmentId)
      }
    })
  }
  return { kid: id, privateKey: await (privateKey as Promise<CryptoKey>) }
}

/**
 * The public key set verifiers fetch: `next`, `active` and recently retired keys, newest first,
 * never more than the kit's limit of 20, and never a private key.
 */
export async function publicKeySet(deps: KeyDeps, tenant: Tenant): Promise<Jwks> {
  let keys = await deps.signingKeys.verificationKeys(
    tenant.environmentId,
    deps.clock.now(),
    MAX_JWKS_KEYS
  )
  if (keys.length === 0) {
    await ensureKeys(deps, tenant)
    keys = await deps.signingKeys.verificationKeys(
      tenant.environmentId,
      deps.clock.now(),
      MAX_JWKS_KEYS
    )
  }
  return { keys }
}

// The verifier's key set of each environment, rebuilt only when the published kids change. A kid's
// public key never changes, so the kids identify the set.
const keySets = new Map<string, { kids: string; set: ReturnType<typeof createStaticKeySet> }>()

/** The key set a verifier checks tokens against, rebuilt only when the published keys change. */
export async function verificationKeySet(deps: KeyDeps, tenant: Tenant) {
  const jwks = await publicKeySet(deps, tenant)
  const kids = jwks.keys.map((key) => key.kid).join(',')
  let cached = keySets.get(tenant.environmentId)
  if (cached?.kids !== kids) {
    cached = { kids, set: createStaticKeySet(jwks) }
    keySets.set(tenant.environmentId, cached)
  }
  return cached.set
}

/** Thrown by {@link rotate} while the next key is too new, or when a concurrent rotation won. */
export class RotationRefused extends Error {
  /** Seconds until rotation is allowed; 0 when a concurrent rotation won. */
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super('signing keys cannot be rotated now')
    this.name = 'RotationRefused'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Rotate the keys: `active → retired`, `next → active`, and a new `next`.
 *
 * Refused while the `next` key is younger than {@link NEXT_KEY_MIN_AGE_MS}, so a verifier with a
 * cached key set never meets a token signed by a key it has not seen. No route calls this yet.
 *
 * @throws RotationRefused when the next key is too new or another rotation won.
 */
export async function rotate(deps: KeyDeps, tenant: Tenant): Promise<void> {
  await ensureKeys(deps, tenant)
  const keys = await deps.signingKeys.list(tenant.environmentId)
  const active = keys.find((key) => key.status === 'active')
  const next = keys.find((key) => key.status === 'next')
  if (!active || !next) {
    throw new RotationRefused(0)
  }
  const now = deps.clock.now()
  const waitMs = next.createdAt.getTime() + NEXT_KEY_MIN_AGE_MS - now.getTime()
  if (waitMs > 0) {
    throw new RotationRefused(Math.ceil(waitMs / 1000))
  }
  const upcoming = await generate(deps, tenant, 'next', now)
  const rotated = await deps.signingKeys.rotate(
    tenant.environmentId,
    { retireId: active.id, activateId: next.id, next: upcoming },
    now
  )
  if (!rotated) {
    throw new RotationRefused(0)
  }
}

/**
 * Boot-time check: make sure the keys exist and that the master key opens the active one, so a
 * wrong `AUTH_MASTER_KEY` shows up in the start-up log instead of at the first sign-in.
 */
export async function ensureAtBoot(deps: KeyDeps, tenant: Tenant): Promise<void> {
  await ensureKeys(deps, tenant)
  await activeSigningKey(deps, tenant)
}
