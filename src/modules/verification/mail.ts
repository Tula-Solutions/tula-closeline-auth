import type { MailMessage } from '~/ports/mailer'

/** The email that carries a sign-up code. The body holds a secret: never log it. */
export function codeEmail(to: string, code: string, ttlMinutes: number): MailMessage {
  const text =
    `Your Closeline verification code is ${code}.\n\n` +
    `It expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this email.`
  return {
    to,
    subject: 'Your Closeline verification code',
    text,
    html: `<p>Your Closeline verification code is <strong>${code}</strong>.</p><p>It expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this email.</p>`,
  }
}

/** The notice sent instead of a code when someone starts a sign-up for an existing address. */
export function accountExistsEmail(to: string): MailMessage {
  const text =
    'Someone tried to create a Closeline account with this address, which already has one. ' +
    'If it was you, sign in instead. If not, you can ignore this email.'
  return {
    to,
    subject: 'You already have a Closeline account',
    text,
    html: `<p>${text}</p>`,
  }
}
