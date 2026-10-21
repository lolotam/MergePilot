import { describe, expect, it } from 'vitest';
import { Secret } from '../credentials/secret.js';
import {
  MAX_WITHHELD_ITEMS,
  mergeWithheld,
  parseWithheld,
  redactWithheld,
  WITHHELD_REASON_MAX_CHARS,
  WITHHELD_TITLE_MAX_CHARS,
} from './withheld.js';

// ADR-0042: the withheld list is lenient — a bad value or a bad item is skipped, never the answer.

describe('parseWithheld', () => {
  it('keeps nothing when the value is not a list', () => {
    expect(parseWithheld(undefined)).toEqual([]);
    expect(parseWithheld('nope')).toEqual([]);
    expect(parseWithheld({ title: 'Null deref', reason: 'out of scope' })).toEqual([]);
  });

  it('keeps the valid items and skips the invalid ones', () => {
    const items = parseWithheld([
      { title: 'Null deref', reason: 'below the confidence bar' },
      { title: 'No reason' },
      { title: '   ', reason: 'blank title' },
      { title: 'Slow query', reason: 'out of scope' },
    ]);

    expect(items).toEqual([
      { title: 'Null deref', reason: 'below the confidence bar' },
      { title: 'Slow query', reason: 'out of scope' },
    ]);
  });

  it('keeps the raw text, so a secret that spans a line break is still matched later', () => {
    const items = parseWithheld([{ title: 'Null\n## deref', reason: '  out of\r\n\tscope  ' }]);
    expect(items[0]).toEqual({ title: 'Null\n## deref', reason: '  out of\r\n\tscope  ' });
  });

  it('keeps at most ten items', () => {
    const many = Array.from({ length: MAX_WITHHELD_ITEMS + 5 }, (_, i) => ({ title: `T${i}`, reason: 'r' }));
    expect(parseWithheld(many)).toHaveLength(MAX_WITHHELD_ITEMS);
  });
});

describe('mergeWithheld', () => {
  it('drops a repeated title, whatever its case and spacing', () => {
    const merged = mergeWithheld([
      [{ title: 'Null deref', reason: 'first' }],
      [{ title: ' null deref ', reason: 'second' }, { title: 'Slow query', reason: 'other' }],
      undefined,
    ]);

    expect(merged.map((item) => item.title)).toEqual(['Null deref', 'Slow query']);
    expect(merged[0]?.reason).toBe('first');
  });

  it('keeps at most ten items', () => {
    const many = Array.from({ length: MAX_WITHHELD_ITEMS + 5 }, (_, i) => [{ title: `T${i}`, reason: 'r' }]);
    expect(mergeWithheld(many)).toHaveLength(MAX_WITHHELD_ITEMS);
  });

  it('drops a title that only differs in its line breaks', () => {
    const merged = mergeWithheld([
      [{ title: 'a\nb', reason: 'first' }],
      [{ title: 'a b', reason: 'second' }],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.reason).toBe('first');
  });
});

describe('redactWithheld', () => {
  it('replaces a known secret in the title and in the reason', () => {
    const secret = new Secret('known-test-value-1234567');
    const items = redactWithheld(
      [{ title: `leak ${secret.reveal()}`, reason: `and ${secret.reveal()} again` }],
      [secret],
    );

    expect(items[0]?.title).not.toContain(secret.reveal());
    expect(items[0]?.reason).not.toContain(secret.reveal());
    expect(items[0]?.title).toContain('[REDACTED:known]');
    expect(items[0]?.reason).toContain('[REDACTED:known]');
  });

  it('puts the text on one line after the redaction', () => {
    const [item] = redactWithheld([{ title: 'Null\n## deref', reason: 'out of\r\nscope' }], []);

    expect(item?.title).toBe('Null ## deref');
    expect(item?.reason).toBe('out of scope');
  });

  it('redacts a known secret that contains a line break and repeated spaces', () => {
    const secret = new Secret('known value  with\nbreak-1234567');
    const [item] = redactWithheld(
      [{ title: `leak ${secret.reveal()} here`, reason: `and ${secret.reveal()} again` }],
      [secret],
    );

    expect(item?.title).not.toContain('break-1234567');
    expect(item?.reason).not.toContain('break-1234567');
    expect(item?.title).toContain('[REDACTED:known]');
    expect(item?.reason).toContain('[REDACTED:known]');
  });

  it('cuts a long title and a long reason after redaction, so a cut never splits a secret', () => {
    const secret = new Secret('known-test-value-1234567');
    const title = `${'a'.repeat(WITHHELD_TITLE_MAX_CHARS - 5)}${secret.reveal()}`;
    const [item] = redactWithheld([{ title, reason: 'b'.repeat(500) }], [secret]);

    expect(item?.title).toHaveLength(WITHHELD_TITLE_MAX_CHARS);
    expect(item?.title).not.toContain('known-te');
    expect(item?.reason).toHaveLength(WITHHELD_REASON_MAX_CHARS);
  });

  it('cuts by code points, never inside a surrogate pair', () => {
    const [item] = redactWithheld([{ title: `${'a'.repeat(WITHHELD_TITLE_MAX_CHARS - 1)}😀😀`, reason: 'r' }], []);

    expect(Array.from(item?.title ?? '')).toHaveLength(WITHHELD_TITLE_MAX_CHARS);
    expect(item?.title?.endsWith('😀')).toBe(true);
  });
});
