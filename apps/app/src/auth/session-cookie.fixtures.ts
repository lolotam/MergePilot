import { createHmac } from 'node:crypto';

/** Test-only: a session cookie signed the way Better Auth signs it (HMAC-SHA256, base64). */
export function signedSessionCookie(token: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  const value = encodeURIComponent(`${token}.${signature}`);
  return `better-auth.session_token=${value}; __Secure-better-auth.session_token=${value}`;
}
