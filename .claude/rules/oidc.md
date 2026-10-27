---
paths:
  - "src/modules/oidc/**"
  - "src/adapters/http/google.ts"
  - "src/adapters/memory/oidc-provider.ts"
  - "src/adapters/unconfigured/oidc-provider.ts"
  - "src/ports/oidc-provider.ts"
---

# Sign in with Google (hub ADR 0019)

Server-side OpenID Connect, authorization code with PKCE S256, a `state` and a `nonce`. Browser
clients only. The contract (`tula-closeline-contract` `src/auth/oidc.ts`) owns the schemas, the
routes' descriptions (`GOOGLE_ROUTES`), the cookie base name and the `oidc.*` codes.

- **Storage: no db change.** An attempt is a `flow_attempts` row of kind `sign_in` or `sign_up`
  (the intent) on an `oidc_*` status (`OIDC_STATUSES`, never part of the public `FlowStatus`, so the
  email and password routes answer `flow.not_found` to its secret). `identifier` is
  `google:pending` until the callback learns the address. `state` (jsonb) holds `provider:
  'google'`, the SHA-256 of the state's random half and of the nonce, the PKCE verifier and, for a
  new person, the profile `{sub, email, name}`, both sealed with the secret box (purpose
  `oidc-attempt`, the attempt id as AAD; the key derives from `AUTH_MASTER_KEY`). `secretHash` is
  the SHA-256 of the cookie secret. The `state` value is `<attempt id>.<256-bit random>`: the id
  finds the row by primary key, the hash is compared in constant time.
- **Steps.** `oidc_started` (start) -> `oidc_exchanging` (the callback spent the state, whatever
  comes next) -> `complete` (known or linked user) or `oidc_pending` (new person; the callback
  creates nothing) -> `complete` (inside the transaction that writes the user).
- **Callback** answers 302 for every outcome but `oidc.disabled` (404). A request whose state or
  cookie does not match is refused without spending the attempt and without clearing any cookie.
- **Linking** only for a user with a password and no Google identity (ADR 0011 ASCII fold). Any
  other match, an address ADR 0011 cannot store and a banned account are `oidc.state_invalid`, the
  neutral refusal. The link writes the identity and an `auth.audit_logs` row `google_linked` in one
  transaction.
- **Complete**: core first (`signup:<attempt id>`, so a retry after a crash gets the same
  Organization), then `UserRepository.createGoogleUser` writes user, both identities and consumes
  the attempt in ONE transaction. Never consume the attempt before core has answered. Core answers
  the same for an unknown Invitation and for another address, so any refused Invitation is
  reported as `oidc.invitation_mismatch`.
- **Verification extras**: several audiences need `azp` equal to the client id; a response body is read through a stream and cut at 1 MiB (no retry); a stale cached key (at most 24 h old) still verifies a token naming its `kid` when the refetch fails, and after a failed refresh nothing is refetched for 30 s; an `azp` that is not the client id is refused whatever `aud` is.
- **Provider calls**: 5 s each, at most 2 jittered retries on a network error or a 5xx; the code
  exchange is retried only when no response came back. Keys are cached, refetched on an unknown
  `kid` at most once per 30 s. RS256 only, 60 s of skew.
- **Rate limits** are per source (the `X-Forwarded-For` hop `TRUSTED_PROXY_HOPS` from the right; a shorter header is refused with `request.invalid` outside `local`; the callback redirects to `/sign-in?error=request.invalid`, the others answer 400) on all four routes, plus a cap
  per attempt on `complete`. The edge limit in AGENTS.md still applies.
- **Tests**: `createTestDeps().oidc` is the real HTTP adapter over an in-process fake Google
  (`adapters/memory/oidc-provider.ts`) with controls for every failure.
