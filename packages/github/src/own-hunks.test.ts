import { describe, expect, it } from 'vitest';
import { ownHunks } from './own-hunks.js';

describe('ownHunks', () => {
  const pr = '@@ -1,3 +1,3 @@\n context\n-removed by pr\n+added by pr\n';

  it('keeps hunks whose changed lines are in the PR diff and drops base-branch hunks', () => {
    const compare = '@@ -1 +1 @@\n+added by pr\n@@ -50 +50 @@\n-from main\n+also from main';
    expect(ownHunks(compare, pr)).toBe('@@ -1 +1 @@\n+added by pr');
  });

  it('a removal the PR made counts as its own', () => {
    expect(ownHunks('@@ -1 +1 @@\n-removed by pr', pr)).toBe('@@ -1 +1 @@\n-removed by pr');
  });

  it('returns undefined when no hunk is the PR\'s', () => {
    expect(ownHunks('@@ -9 +9 @@\n-a\n+b', pr)).toBeUndefined();
  });

  it('blank lines never decide; a hunk with only blank changes is kept', () => {
    expect(ownHunks('@@ -9 +9 @@\n+\n+   ', '@@ -1 +1 @@\n+\n')).toBe('@@ -9 +9 @@\n+\n+   ');
    expect(ownHunks('@@ -9 +9 @@\n+\n+from main', '@@ -1 +1 @@\n+\n+x')).toBeUndefined();
  });

  it('keeps the whole patch when the PR patch is unknown (too large for GitHub)', () => {
    expect(ownHunks('@@ -9 +9 @@\n+b', undefined)).toBe('@@ -9 +9 @@\n+b');
  });
});
