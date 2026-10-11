import { describe, expect, it } from 'vitest';
import { buildMarker, parseMarker } from './marker.js';

describe('marker', () => {
  it('builds marker with headSha and configHash', () => {
    const marker = buildMarker({ headSha: 'abc1234', configHash: 'cfg5678' });
    expect(marker).toBe('<!-- mergepilot:review head=abc1234 config=cfg5678 -->');
  });

  it('marker round-trips correctly', () => {
    const original = { headSha: 'sha-abcdef0123456789', configHash: 'hash-9876543210' };
    const marker = buildMarker(original);
    const parsed = parseMarker(marker);
    expect(parsed).toEqual(original);
  });

  it('parses marker embedded within summary markdown', () => {
    const body = [
      '## Review Summary',
      'Everything looks good.',
      '',
      '<!-- mergepilot:review head=head-sha-42 config=conf-hash-99 -->',
    ].join('\n');

    const parsed = parseMarker(body);
    expect(parsed).toEqual({
      headSha: 'head-sha-42',
      configHash: 'conf-hash-99',
    });
  });

  it('returns null when marker is absent', () => {
    const body = 'Just a regular comment without any hidden markers.';
    expect(parseMarker(body)).toBeNull();
  });

  it('returns null when body is empty or whitespace', () => {
    expect(parseMarker('')).toBeNull();
    expect(parseMarker('   \n  ')).toBeNull();
  });
});
