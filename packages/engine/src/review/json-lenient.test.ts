import { describe, expect, it } from 'vitest';
import { parseJsonLenient, repairInvalidEscapes } from './json-lenient.js';

describe('parseJsonLenient', () => {
  it('parses an answer whose string quotes a regex with invalid escapes', () => {
    const json = String.raw`{"evidence": "/deepseek-v(?:[4-9]|\d{2})/.test(m)", "path": "C:\Dev\a.ts"}`;
    expect(() => JSON.parse(json)).toThrow();
    expect(parseJsonLenient(json)).toEqual({
      evidence: String.raw`/deepseek-v(?:[4-9]|\d{2})/.test(m)`,
      path: String.raw`C:\Dev\a.ts`,
    });
  });

  it('keeps valid escapes, including an escaped backslash before a letter', () => {
    const json = String.raw`{"a": "line\nnext \"q\" \\d \u00e9 \/"}`;
    expect(repairInvalidEscapes(json)).toBe(json);
    expect(parseJsonLenient(json)).toEqual({ a: 'line\nnext "q" \\d é /' });
  });

  it('still throws for JSON that is broken in other ways', () => {
    expect(() => parseJsonLenient('{"a": 1,')).toThrow();
  });
});
