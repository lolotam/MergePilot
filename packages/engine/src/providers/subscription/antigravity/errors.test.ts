import { describe, expect, it } from 'vitest';
import { failureKind } from '../../../llm/failure.js';
import { antigravityFailure } from './errors.js';

const access = 'fake-echoed-access-token';

function rpc(code: number, status: string, message: string, details: unknown[] = []): string {
  return JSON.stringify({ error: { code, status, message, details } });
}

const retryInfo = (delay: string) => ({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
const errorInfo = (reason: string) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason });

describe('antigravityFailure', () => {
  it('classifies a short RESOURCE_EXHAUSTED as a rate limit with its retry delay', () => {
    const failure = antigravityFailure(429, rpc(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', [retryInfo('12.5s')]), 'm');
    expect(failure).toMatchObject({ code: 'RATE_LIMIT', retryAfterMs: 12_500, status: 429, provider: 'google-antigravity' });
  });

  it('classifies a long reset as quota, from RetryInfo or from the message', () => {
    expect(antigravityFailure(429, rpc(429, 'RESOURCE_EXHAUSTED', 'quota', [retryInfo('7200s')]), 'm').code).toBe('QUOTA');
    expect(antigravityFailure(429, rpc(429, 'RESOURCE_EXHAUSTED', 'You have exhausted your capacity. Your quota will reset after 3h20m5s.'), 'm'))
      .toMatchObject({ code: 'QUOTA', retryAfterMs: (3 * 3600 + 20 * 60 + 5) * 1000 });
    expect(antigravityFailure(429, rpc(429, 'RESOURCE_EXHAUSTED', 'x', [errorInfo('QUOTA_EXHAUSTED')]), 'm').code).toBe('QUOTA');
  });

  it('treats a bare 429 without timing as a rate limit, not quota', () => {
    expect(antigravityFailure(429, rpc(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).'), 'm').code).toBe('RATE_LIMIT');
  });

  it('maps 401 to sign in again', () => {
    const failure = antigravityFailure(401, rpc(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.'), 'm');
    expect(failure.code).toBe('INVALID_CREDENTIAL');
    expect(failure.message).toMatch(/sign in again/);
  });

  it('gives verification and suspension 403s their own messages without forwarding the body', () => {
    const validation = antigravityFailure(403, rpc(403, 'PERMISSION_DENIED', 'VALIDATION_REQUIRED: verify at https://accounts.example.test/verify?token=abc'), 'm');
    expect(validation.code).toBe('INVALID_CREDENTIAL');
    expect(validation.message).toMatch(/verify this account/);
    expect(validation.message).not.toContain('example.test');

    const suspended = antigravityFailure(403, rpc(403, 'PERMISSION_DENIED', 'This service has been disabled in this account for violation of Terms of Service.'), 'm');
    expect(suspended).toMatchObject({ code: 'INVALID_CREDENTIAL', message: 'Google disabled Antigravity access for this account' });
    // Kind auth: the ADR-0027 quota/rate-limit triggers never pay around a suspension.
    expect(failureKind(suspended.code)).toBe('auth');
  });

  it.each([
    [404, rpc(404, 'NOT_FOUND', 'model'), 'BAD_REQUEST'],
    [400, rpc(400, 'INVALID_ARGUMENT', 'The input token count exceeds the maximum number of tokens allowed'), 'CONTEXT_WINDOW_EXCEEDED'],
    [400, rpc(400, 'INVALID_ARGUMENT', 'Invalid value at contents[0]'), 'BAD_REQUEST'],
    [503, rpc(503, 'UNAVAILABLE', 'overloaded'), 'SERVER'],
    [504, '', 'TIMEOUT'],
  ])('maps HTTP %i to its failure code', (status, body, code) => {
    expect(antigravityFailure(status, body, 'gemini-x').code).toBe(code);
  });

  it('names the model a 404 refers to', () => {
    expect(antigravityFailure(404, '', 'gemini-x').message).toContain('gemini-x');
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 503])('forwards no body text for HTTP %i, even a token echoed across the 300-character cut', (status) => {
    // The token starts just before the old 300-character truncation point, so a partial copy would survive a cut.
    const echoed = `${'x'.repeat(290)} Bearer ${access} rest of the body`;
    const failure = antigravityFailure(status, rpc(status, 'INVALID_ARGUMENT', echoed), 'm');
    expect(failure.message).not.toContain(access.slice(0, 8));
    expect(failure.message).not.toContain('xxxxx');
    expect(failure.message).not.toContain('rest of the body');
  });

  it('keeps only the RPC status enum name of a bad request', () => {
    expect(antigravityFailure(400, rpc(400, 'INVALID_ARGUMENT', 'Invalid value at contents[0]'), 'm').message)
      .toBe('Google Antigravity rejected the request: HTTP 400 INVALID_ARGUMENT (BAD_REQUEST)');
    expect(antigravityFailure(400, rpc(400, `not an enum ${access}`, 'x'), 'm').message).not.toContain(access);
  });
});
