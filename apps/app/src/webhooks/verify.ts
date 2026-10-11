import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a GitHub webhook signature using HMAC-SHA256 over raw body bytes.
 * Returns false on missing/malformed header, mismatched lengths, or wrong signature.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || typeof header !== 'string' || !header.startsWith('sha256=')) {
    return false;
  }
  if (!secret || typeof secret !== 'string') {
    return false;
  }
  if (!Buffer.isBuffer(rawBody)) {
    return false;
  }

  const expectedDigest = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedHeader = `sha256=${expectedDigest}`;

  const headerBuffer = Buffer.from(header, 'utf8');
  const expectedBuffer = Buffer.from(expectedHeader, 'utf8');

  // timingSafeEqual throws RangeError if buffer lengths differ
  if (headerBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(headerBuffer, expectedBuffer);
}
