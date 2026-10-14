/** What Google reported about the person, once the ID token has been fully verified. */
export interface GoogleProfile {
  /** Google's stable id for the account: the key of the Linked Google account. */
  subject: string
  /** The address Google vouches for (`email_verified` was true). */
  email: string
  /** The display name, or `null`. */
  name: string | null
  /** The given name, or `null`. */
  givenName: string | null
  /** The family name, or `null`. */
  familyName: string | null
  /** The `nonce` claim; the caller compares it with the one it stored. */
  nonce: string
}

/**
 * Why a call to the provider failed:
 * - `disabled`: Sign in with Google is not set up;
 * - `unavailable`: the provider could not be reached or answered 5xx (a retry may work);
 * - `rejected`: the provider refused the code (`invalid_grant` and the like); never retried;
 * - `invalid_token`: the ID token failed verification (signature, issuer, audience, expiry...);
 * - `email_unverified`: the token is valid but Google does not vouch for the address.
 */
export type OidcFailureReason =
  | 'disabled'
  | 'unavailable'
  | 'rejected'
  | 'invalid_token'
  | 'email_unverified'

/** What an {@link OidcProvider} throws. The message never holds a token, a code or a secret. */
export class OidcFailure extends Error {
  constructor(
    readonly reason: OidcFailureReason,
    detail?: string
  ) {
    super(detail === undefined ? `oidc: ${reason}` : `oidc: ${reason} (${detail})`)
    this.name = 'OidcFailure'
  }
}

/** The OpenID Connect provider (Google): discovery, the authorization URL, the code exchange. */
export interface OidcProvider {
  /** Whether Sign in with Google is set up. The auth options report it. */
  readonly enabled: boolean

  /**
   * The URL to send the browser to, for the authorization-code flow with PKCE S256.
   *
   * @param input.state - The opaque state to be echoed back.
   * @param input.nonce - The nonce the ID token must carry.
   * @param input.codeChallenge - The S256 challenge of the PKCE verifier.
   * @throws OidcFailure `disabled`, `unavailable`.
   */
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): Promise<string>

  /**
   * Trades the code for an ID token, once: a response (even an error one) is never retried.
   *
   * @throws OidcFailure `disabled`, `unavailable`, `rejected`.
   */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ idToken: string }>

  /**
   * Verifies the ID token: RS256 only, issuer, audience, `exp` and `iat` within 60 s of skew, a
   * present `sub` and `email`, and `email_verified` true. The nonce is returned, not compared.
   *
   * @throws OidcFailure `disabled`, `unavailable` (the keys could not be fetched),
   *   `invalid_token`, `email_unverified`.
   */
  verifyIdToken(idToken: string): Promise<GoogleProfile>
}
