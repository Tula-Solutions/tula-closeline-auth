---
paths:
  - "src/modules/session/**"
  - "src/http/client.ts"
  - "src/modules/flow/router.ts"
  - "src/modules/flow/schema.ts"
---

# Sessions and the refresh cookie

Reuse detection, the grace window and the membership rules (`membership.md`) are the same for every
client type: the cookie is a transport change only.

- **Client type.** `x-tula-client: browser` selects the cookie flow. It is stored as session client
  `web` (the database enum has no `browser`). Any other value, or none, keeps the token in the body,
  byte for byte: `Sessions.bodyOf` builds that body, `browserBodyOf` the one without
  `refreshToken`. `IssuedSession.absoluteExpiresAt` is never a body field.
- **Cookie** (`modules/session/cookie.ts`): `__Secure-tula_refresh`, `Path=/v1/client/sessions/`
  (the narrowest common prefix of refresh and sign-out; the trailing slash keeps it off the list
  route and every other service), `Max-Age` = remaining absolute lifetime, `HttpOnly`, `Secure`,
  `SameSite=Strict`, no `Domain`. With `SESSION_COOKIE_INSECURE=true` (`local` only, refused
  elsewhere at boot) the name is `tula_refresh` and `Secure` is dropped; nothing else changes.
- **Reading.** For `browser`, refresh and sign-out run in a middleware in front of the body routes
  (`cookieFlow` in `router.ts`): Origin check, then the cookie, never the body or a header. A missing
  cookie is `session.invalid_token`; sign-out clears the cookie (`Max-Age=0`, same attributes)
  whether or not a session was found.
- **Origin check.** `SESSION_ALLOWED_ORIGINS` exact match, `Sec-Fetch-Site` `same-origin` if present,
  else `auth.forbidden` before the token is looked at. No CORS headers anywhere.
- Responses that set or clear the cookie carry `Cache-Control: no-store`. Never log, report or put a
  cookie or `Set-Cookie` value in an error detail (`cookie.test.ts` pins it).
- OpenAPI documents two response shapes (`SessionTokens` / `BrowserSessionTokens`,
  `FlowResponse` / `BrowserFlowResponse`) as `anyOf`, the cookie as a cookie parameter, and
  `Set-Cookie` as a response header.
