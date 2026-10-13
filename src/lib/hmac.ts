import { createHmac } from 'node:crypto'

/**
 * HMAC-SHA-256 of a UTF-8 message under a UTF-8 key.
 *
 * @param key - The secret key; never logged.
 * @param message - What to authenticate.
 * @returns The 32-byte tag.
 */
export function hmacSha256(key: string, message: string): Buffer {
  return createHmac('sha256', key).update(message).digest()
}
