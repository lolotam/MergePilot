import { describe, expect, it } from 'vitest';
import { ar } from '../../i18n/ar.js';
import { en } from '../../i18n/en.js';
import { arWebScan } from '../../i18n/webscan-ar.js';
import { enWebScan } from '../../i18n/webscan-en.js';

/**
 * The dictionary of the website scan area.
 *
 * The two languages carry the same keys, and the copy of the area says what
 * the area does: the audit log is immutable, so no language may say that it
 * is deleted.
 */

/** A character of a script that no language of the area is written in. */
const FOREIGN_SCRIPT = /[\u3000-\u9FFF\uAC00-\uD7AF]/;

describe('the dictionary of the website scan', () => {
  it('has every key of the area in both languages', () => {
    const arKeys = Object.keys(ar)
      .filter((key) => key.startsWith('webscan'))
      .sort();
    const enKeys = Object.keys(en)
      .filter((key) => key.startsWith('webscan'))
      .sort();

    expect(arKeys).toEqual(enKeys);
    expect(arKeys.length).toBeGreaterThan(50);
  });

  it('says in English that the audit log cannot be edited and cannot be deleted', () => {
    expect(en.webscanAuditDesc).toContain('cannot be edited');
    expect(en.webscanAuditDesc).toContain('cannot be deleted');
  });

  it('says in Arabic that the audit log cannot be edited and cannot be deleted', () => {
    const text = ar.webscanAuditDesc;
    // The positive form of "is deleted" would say the opposite of the
    // feature, so the Arabic copy may not use it.
    expect(text).not.toContain('بيتمسح');
    expect(text).not.toContain('يتمسح');
    expect(text).toContain('مش بيتعدّل');
    expect(text).toContain('مش بيتشال');
  });

  it('writes no character of another script in the copy of the area', () => {
    const offenders = [
      ...Object.entries(arWebScan)
        .filter(([, value]) => FOREIGN_SCRIPT.test(value))
        .map(([key]) => `ar:${key}`),
      ...Object.entries(enWebScan)
        .filter(([, value]) => FOREIGN_SCRIPT.test(value))
        .map(([key]) => `en:${key}`),
    ];

    expect(offenders).toEqual([]);
  });
});
