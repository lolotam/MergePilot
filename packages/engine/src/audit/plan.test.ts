import { describe, expect, it } from 'vitest';
import { planAudit } from './plan.js';

describe('planAudit', () => {
  it('returns empty chunks and skipped for empty file list', () => {
    const result = planAudit({
      files: [],
      maxInputTokens: 100000,
    });
    expect(result.chunks).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('sorts files deterministically in path ascending order', () => {
    const result = planAudit({
      files: [
        { path: 'src/z.ts', size: 350 },
        { path: 'src/a.ts', size: 350 },
        { path: 'src/m.ts', size: 350 },
      ],
      maxInputTokens: 100000,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('splits files into chunks fitting maxInputTokens * 0.7', () => {
    // maxInputTokens = 1000 -> budget = 700 tokens
    // size 350 -> size/3.5 = 100 tokens
    // 7 files of 100 tokens = 700 tokens fit exactly in 1 chunk
    // 8th file starts a new chunk
    const files = Array.from({ length: 15 }, (_, i) => ({
      path: `src/file_${String(i).padStart(2, '0')}.ts`,
      size: 350, // 100 tokens each
    }));

    const result = planAudit({
      files,
      maxInputTokens: 1000, // chunk budget = 700 tokens (7 files)
    });

    expect(result.chunks).toHaveLength(3);
    expect(result.chunks[0]).toHaveLength(7);
    expect(result.chunks[1]).toHaveLength(7);
    expect(result.chunks[2]).toHaveLength(1);
  });

  it('skips sensitive paths', () => {
    const result = planAudit({
      files: [
        { path: 'src/index.ts', size: 100 },
        { path: '.env', size: 100 },
        { path: 'keys/server.pem', size: 100 },
        { path: 'id_rsa', size: 100 },
      ],
      maxInputTokens: 100000,
    });

    expect(result.chunks).toEqual([['src/index.ts']]);
    expect(result.skipped).toEqual([
      { path: '.env', reason: 'sensitive' },
      { path: 'id_rsa', reason: 'sensitive' },
      { path: 'keys/server.pem', reason: 'sensitive' },
    ]);
  });

  it('skips binary files', () => {
    const result = planAudit({
      files: [
        { path: 'src/index.ts', size: 100 },
        { path: 'assets/logo.png', size: 1000 },
        { path: 'assets/hero.jpg', size: 1000 },
        { path: 'docs/manual.pdf', size: 1000 },
        { path: 'bundle.zip', size: 1000 },
        { path: 'fonts/inter.woff', size: 1000 },
      ],
      maxInputTokens: 100000,
    });

    expect(result.chunks).toEqual([['src/index.ts']]);
    expect(result.skipped).toEqual([
      { path: 'assets/hero.jpg', reason: 'binary' },
      { path: 'assets/logo.png', reason: 'binary' },
      { path: 'bundle.zip', reason: 'binary' },
      { path: 'docs/manual.pdf', reason: 'binary' },
      { path: 'fonts/inter.woff', reason: 'binary' },
    ]);
  });

  it('skips files matching exclude globs', () => {
    const result = planAudit({
      files: [
        { path: 'src/index.ts', size: 100 },
        { path: 'pnpm-lock.yaml', size: 500 },
        { path: 'docs/guide.md', size: 500 },
      ],
      exclude: ['**/*.lock', 'pnpm-lock.yaml', 'docs/**'],
      maxInputTokens: 100000,
    });

    expect(result.chunks).toEqual([['src/index.ts']]);
    expect(result.skipped).toEqual([
      { path: 'docs/guide.md', reason: 'excluded' },
      { path: 'pnpm-lock.yaml', reason: 'excluded' },
    ]);
  });

  it('skips files not matching include globs', () => {
    const result = planAudit({
      files: [
        { path: 'src/index.ts', size: 100 },
        { path: 'tests/index.test.ts', size: 100 },
      ],
      include: ['src/**'],
      maxInputTokens: 100000,
    });

    expect(result.chunks).toEqual([['src/index.ts']]);
    expect(result.skipped).toEqual([
      { path: 'tests/index.test.ts', reason: 'excluded' },
    ]);
  });

  it('enforces maxFiles limit and marks remaining as skipped', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      path: `src/f${i}.ts`,
      size: 100,
    }));

    const result = planAudit({
      files,
      maxFiles: 3,
      maxInputTokens: 100000,
    });

    expect(result.chunks[0]).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts']);
    expect(result.skipped).toHaveLength(7);
    expect(result.skipped[0]).toEqual({ path: 'src/f3.ts', reason: 'max-files' });
  });

  it('isolates a single file in its own chunk if it exceeds the chunk budget', () => {
    const result = planAudit({
      files: [
        { path: 'src/a.ts', size: 350 }, // 100 tokens
        { path: 'src/m_huge.ts', size: 3500 }, // 1000 tokens > budget (700)
        { path: 'src/z.ts', size: 350 }, // 100 tokens
      ],
      maxInputTokens: 1000, // chunk budget = 700 tokens
    });

    expect(result.chunks).toEqual([
      ['src/a.ts'],
      ['src/m_huge.ts'],
      ['src/z.ts'],
    ]);
  });
});
