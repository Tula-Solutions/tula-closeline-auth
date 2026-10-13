---
paths:
  - "src/adapters/mailpit/**"
  - "src/adapters/unconfigured/**"
  - "src/env.ts"
  - "src/container.ts"
---

# Mail

There is no production mail provider yet (hub issue #35). `createMailer` in `src/container.ts`
returns the unconfigured mailer, which fails every send, so sign-up answers 503 `mail.unavailable`.

Local development only: `MAIL_LOCAL_URL` selects `src/adapters/mailpit/mailer.ts`, which posts each
message to Mailpit's send API (`POST /api/v1/send`: `From {Email}`, `To [{Email}]`, `Subject`,
`Text`, `HTML`). `MAIL_LOCAL_FROM` is its sender (default `no-reply@closeline.test`).

- `src/env.ts` accepts both keys only when `ENVIRONMENT=local`, and the URL only as an `http`
  origin written exactly `http://127.0.0.1`, `http://[::1]` or `http://localhost` (optional port
  1 to 65535, optional trailing slash; no other spelling of the address), stored as that canonical
  origin. A blank value is refused: leave the key out. `createMailer` throws if the URL is set in
  any other environment. A refusal names the key and the rule, never the value.
- Each attempt has a 2 s timeout; at most 3 attempts, with a jittered pause, on a network error, a
  timeout or a 5xx. A 4xx or a redirect is final. The failure is `MailDeliveryFailed`.
- Nothing logs or throws an address, subject, code, link, body or the mailbox's answer: only an
  HTTP status, a failure kind and an attempt number. `mailer.test.ts` fails on any leak.
- The adapter sends with `node:http`, never `fetch`: Bun's `fetch` obeys `HTTP_PROXY` and would hand the code and address to the proxy. A test sets every proxy variable and fails if the proxy sees a request.
- The connection is pinned to loopback: a `lookup` refuses any address that is not in `127.0.0.0/8` or `::1`, so a hosts-file or resolver answer for `localhost` that points elsewhere fails the send (final, not retried) and the address is never repeated in an error or log.
