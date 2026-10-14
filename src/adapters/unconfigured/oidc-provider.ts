import { OidcFailure, type OidcProvider } from '~/ports/oidc-provider'

/** The provider used when Google is not set up: every call answers `oidc.disabled`. */
export function createUnconfiguredOidcProvider(): OidcProvider {
  const off = async (): Promise<never> => {
    throw new OidcFailure('disabled')
  }
  return {
    enabled: false,
    authorizationUrl: off,
    exchangeCode: off,
    verifyIdToken: off,
  }
}
