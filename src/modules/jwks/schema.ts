import { z } from 'zod'

/** The only signing algorithm this service issues, and the only one a verifier accepts. */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA'

/** An Ed25519 public key in JWK form: public parameters only, never `d`. */
export const jwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().min(1).max(64),
  kid: z.string().min(1).max(64),
  alg: z.literal(ACCESS_TOKEN_ALGORITHM),
  use: z.literal('sig'),
})

/** The public key set served at `/.well-known/jwks.json`: at most 20 keys. */
export const jwksSchema = z.object({ keys: z.array(jwkSchema).max(20) })

/** An Ed25519 public key in JWK form. */
export type Jwk = z.infer<typeof jwkSchema>
/** The public key set. */
export type Jwks = z.infer<typeof jwksSchema>
