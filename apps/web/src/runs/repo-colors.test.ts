import { describe, expect, it } from 'vitest';
import { REPO_PALETTE, hashRepo, repoColor } from './repo-colors.js';

describe('repo colors', () => {
  it('has ten distinct palette keys with literal Tailwind classes', () => {
    expect(REPO_PALETTE).toHaveLength(10);
    expect(new Set(REPO_PALETTE.map((c) => c.key)).size).toBe(10);
    for (const c of REPO_PALETTE) {
      expect(c.strip).toContain('border-s-4');
      expect(c.strip).toContain(`border-s-${c.key}-500`);
      expect(c.chip).toContain(`text-${c.key}-900`);
      expect(c.chip).toContain(`dark:text-${c.key}-100`);
    }
  });

  it('hashes the same repo to the same color, case-insensitively', () => {
    expect(hashRepo('acme/backend')).toBe(hashRepo('acme/backend'));
    expect(hashRepo('Acme/Backend')).toBe(hashRepo('acme/backend'));
    expect(repoColor('acme/backend').key).toBe(repoColor('acme/backend').key);
  });

  it('spreads repos across the palette', () => {
    const used = new Map<string, number>();
    for (let i = 0; i < 500; i++) {
      const key = repoColor(`org-${i % 37}/repo-${i}`).key;
      used.set(key, (used.get(key) ?? 0) + 1);
    }
    expect(used.size).toBe(10);
    for (const n of used.values()) expect(n).toBeGreaterThan(20);
  });

  it('a chosen color overrides the hash; unknown keys fall back to it', () => {
    const auto = repoColor('acme/backend').key;
    const other = REPO_PALETTE.find((c) => c.key !== auto)!.key;
    expect(repoColor('acme/backend', { 'acme/backend': other }).key).toBe(other);
    expect(repoColor('acme/backend', { 'acme/web': other }).key).toBe(auto);
    expect(repoColor('acme/backend', {}).key).toBe(auto);
  });
});
