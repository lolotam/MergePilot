import { describe, expect, it } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { fallbackReasonOf, MAX_FALLBACK_DETAIL } from './fallback-reason.js';

// Any string can be a known secret; this one matches no secret pattern on purpose.
const KEY = 'placeholder-credential-for-test-only';

describe('fallbackReasonOf', () => {
  it('is undefined when no fallback took over', () => {
    expect(fallbackReasonOf({}, [])).toBeUndefined();
    expect(fallbackReasonOf({ fallbackFrom: 'a:b' }, [])).toBeUndefined();
  });

  it('redacts a known secret even when it straddles the display cut', () => {
    // The key starts 20 characters before the cut: unredacted, 20 of its characters would show.
    const message = `${'x'.repeat(MAX_FALLBACK_DETAIL - 25)} key=${KEY} rejected`;
    const reason = fallbackReasonOf({ fallbackFrom: 'opencode-zen:m', fallbackCode: 'auth', fallbackDetail: message }, [new Secret(KEY)]);
    const detail = reason?.detail ?? '';
    expect(Array.from(detail)).toHaveLength(MAX_FALLBACK_DETAIL);
    expect(detail).toContain('[REDACTED');
    for (let n = 6; n <= KEY.length; n++) expect(detail).not.toContain(KEY.slice(0, n));
  });

  it('drops control characters and never cuts inside a surrogate pair', () => {
    const reason = fallbackReasonOf(
      { fallbackFrom: 'a:b', fallbackCode: 'auth', fallbackDetail: `bad\u0007\u001b[31m ${'😀'.repeat(400)}` },
      [],
    );
    const detail = reason?.detail ?? '';
    expect([...detail].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false);
    expect(detail.startsWith('bad [31m 😀')).toBe(true);
    expect(detail.endsWith('😀…')).toBe(true);
    expect(detail).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it('keeps a short answer as it is', () => {
    expect(fallbackReasonOf({ fallbackFrom: 'a:b', fallbackCode: 'auth', fallbackDetail: 'HTTP 401: model not enabled' }, [])).toEqual({
      from: 'a:b',
      code: 'auth',
      detail: 'HTTP 401: model not enabled',
    });
  });
});
