import type { Mailer } from '~/ports/mailer'

/** Thrown by the mailer of a deployment with no mail provider configured. */
export class MailerNotConfigured extends Error {
  constructor() {
    super('no mail provider is configured')
    this.name = 'MailerNotConfigured'
  }
}

/** A mailer that refuses to send; the runtime default until a provider is chosen. */
export function createUnconfiguredMailer(): Mailer {
  return {
    async send() {
      throw new MailerNotConfigured()
    },
  }
}
