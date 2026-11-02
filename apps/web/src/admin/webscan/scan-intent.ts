/**
 * The idempotency key of a manual scan (ADR-0052 section 7).
 *
 * The key belongs to the start intent, not to the button: the same key is sent
 * again while the request was never accepted, so the server replays its scan
 * instead of queueing a second one. A new intent gets a new key.
 */

/** The prefix of every key, so a stored key is readable in the database. */
const KEY_PREFIX = 'manual-';

/**
 * A fresh idempotency key.
 *
 * The key is a random value, never a guess: the server answers the same key
 * with the same scan, so two different scans must never share one.
 */
export function newScanIdempotencyKey(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') {
    return `${KEY_PREFIX}${source.randomUUID()}`;
  }
  if (typeof source?.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    return `${KEY_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `${KEY_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
