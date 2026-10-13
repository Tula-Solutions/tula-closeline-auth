import type { Logger } from 'tula-closeline-kit'
import type { Mailer, MailMessage } from '~/ports/mailer'

/** The longest one attempt to hand a message to the local mailbox may take. */
export const MAIL_ATTEMPT_TIMEOUT_MS = 2_000

/** How many times a message is handed over at most: the first try and two retries. */
export const MAIL_MAX_ATTEMPTS = 3

/** The sender address of a local deployment: under the reserved `.test` domain (RFC 6761). */
export const DEFAULT_LOCAL_MAIL_FROM = 'no-reply@closeline.test'

/** The pause before a retry: 50 to 150 ms, so instances do not retry in step. */
function defaultRetryDelayMs(): number {
  return 50 + Math.random() * 100
}

/**
 * Thrown when the local mailbox did not take a message. The text holds only an HTTP status or a
 * kind of failure and the attempt count, never an address, a subject, a code, a link or a body.
 */
export class MailDeliveryFailed extends Error {
  constructor(reason: string, attempts: number) {
    super(`local mail delivery failed (${reason}, ${attempts} attempt${attempts === 1 ? '' : 's'})`)
    this.name = 'MailDeliveryFailed'
  }
}

/** Options for {@link createMailpitMailer}. */
export type MailpitMailerOptions = {
  /** The mailbox's origin, such as `http://127.0.0.1:8025`. */
  baseUrl: string
  /** The `From` address of every message. */
  from: string
  /** Where a retry is noted. It receives a status or a failure kind and an attempt number only. */
  logger?: Pick<Logger, 'warn'>
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** One attempt's bound; defaults to {@link MAIL_ATTEMPT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** How long to pause before a retry; defaults to a jittered 50 to 150 ms. */
  retryDelayMs?: () => number
}

/** How one attempt ended, and whether another attempt could help. */
type Outcome = { ok: true } | { ok: false; reason: string; retryable: boolean }

/**
 * A mailer for local development: hands each message to a Mailpit mailbox over its HTTP send API
 * (`POST /api/v1/send`, a JSON body of `From`, `To`, `Subject`, `Text` and `HTML`). The mailbox
 * catches mail and never delivers it, so nothing leaves the machine.
 *
 * Each attempt has a timeout. A network error, a timeout or a 5xx is retried up to
 * {@link MAIL_MAX_ATTEMPTS} attempts in all, after a jittered pause; a 4xx or a redirect is not
 * (the mailbox refused the message, so asking again cannot help). A failure after that rejects
 * with {@link MailDeliveryFailed}, which the sign-up route answers as `mail.unavailable`. No log
 * line or error made here contains the message or any part of it, nor the mailbox's answer.
 */
export function createMailpitMailer(options: MailpitMailerOptions): Mailer {
  const endpoint = new URL('/api/v1/send', options.baseUrl).href
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? MAIL_ATTEMPT_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs

  /** One try at handing the message over. */
  const attempt = async (body: string): Promise<Outcome> => {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        redirect: 'manual',
        signal,
      })
      // The answer is never read: it can echo the message. Free the socket instead.
      await response.body?.cancel()
      if (response.status >= 200 && response.status < 300) {
        return { ok: true }
      }
      return { ok: false, reason: `HTTP ${response.status}`, retryable: response.status >= 500 }
    } catch (error) {
      if (signal.aborted) {
        return { ok: false, reason: 'timeout', retryable: true }
      }
      // The name only: a network error's message can quote what it tried to reach.
      return {
        ok: false,
        reason: `network error ${error instanceof Error ? error.name : 'unknown'}`,
        retryable: true,
      }
    }
  }

  return {
    async send(message: MailMessage): Promise<void> {
      const body = JSON.stringify({
        From: { Email: options.from },
        To: [{ Email: message.to }],
        Subject: message.subject,
        Text: message.text,
        HTML: message.html,
      })
      for (let tries = 1; ; tries += 1) {
        const outcome = await attempt(body)
        if (outcome.ok) {
          return
        }
        if (!outcome.retryable || tries >= MAIL_MAX_ATTEMPTS) {
          throw new MailDeliveryFailed(outcome.reason, tries)
        }
        options.logger?.warn('local mail delivery failed, retrying', {
          reason: outcome.reason,
          attempt: tries,
        })
        await Bun.sleep(retryDelayMs())
      }
    },
  }
}
