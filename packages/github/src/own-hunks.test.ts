import { describe, expect, it } from 'vitest';
import { withoutBaseHunks } from './own-hunks.js';

describe('withoutBaseHunks', () => {
  const pr = '@@ -1,3 +1,3 @@\n context\n-removed by pr\n+added by pr\n+return null;';
  const base = '@@ -50 +50 @@\n-from main\n+also from main\n+return null;';

  it('drops a hunk proven to be the base branch\'s and keeps the PR\'s own', () => {
    const compare = '@@ -1 +1 @@\n+added by pr\n@@ -50 +50 @@\n-from main\n+also from main';
    expect(withoutBaseHunks(compare, base, pr)).toBe('@@ -1 +1 @@\n+added by pr');
  });

  it('a common line shared with the PR does not save a base hunk that has other base lines', () => {
    expect(withoutBaseHunks('@@ -50 +50 @@\n+return null;\n+also from main', base, pr)).toBeUndefined();
  });

  it('keeps a hunk whose lines are all the PR\'s too (cannot tell, so review it)', () => {
    expect(withoutBaseHunks('@@ -9 +9 @@\n+return null;', base, pr)).toBe('@@ -9 +9 @@\n+return null;');
  });

  it('keeps a later deletion of an earlier PR edit: it is not a base-branch change', () => {
    // The PR changed `original` to `intermediate` (reviewed), then deleted `intermediate`: the
    // PR diff only shows `-original`, the compare shows `-intermediate`.
    const prNow = '@@ -1 +1,0 @@\n-original';
    expect(withoutBaseHunks('@@ -1 +1,0 @@\n-intermediate', base, prNow)).toBe('@@ -1 +1,0 @@\n-intermediate');
  });

  it('keeps everything without the base patch, and hunks with only blank-line changes', () => {
    expect(withoutBaseHunks('@@ -50 +50 @@\n-from main', undefined, pr)).toBe('@@ -50 +50 @@\n-from main');
    expect(withoutBaseHunks('@@ -9 +9 @@\n+\n+   ', base, pr)).toBe('@@ -9 +9 @@\n+\n+   ');
  });

  it('an unknown PR patch (too large) still drops hunks proven to be the base branch\'s', () => {
    expect(withoutBaseHunks('@@ -50 +50 @@\n-from main\n+also from main', base, undefined)).toBeUndefined();
  });
});
