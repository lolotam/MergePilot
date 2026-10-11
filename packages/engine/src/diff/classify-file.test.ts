import { describe, expect, it } from 'vitest';
import { classifyFile } from './classify-file.js';

describe('classifyFile', () => {
  const sensitiveList = new Set(['.env', 'secrets/key.pem']);
  const defaultOpts = {
    exclude: [],
    isSensitivePath: (p: string) => sensitiveList.has(p),
  };

  it('classifies removed files as skip-removed', () => {
    const result = classifyFile(
      { path: 'src/deleted.ts', status: 'removed', changes: 10 },
      defaultOpts,
    );
    expect(result).toBe('skip-removed');
  });

  it('classifies sensitive files as skip-sensitive', () => {
    const result = classifyFile(
      { path: '.env', status: 'modified', patch: '@@ -1 +1 @@', changes: 1 },
      defaultOpts,
    );
    expect(result).toBe('skip-sensitive');
  });

  it('prioritizes removed before sensitive', () => {
    const result = classifyFile(
      { path: '.env', status: 'removed', changes: 5 },
      defaultOpts,
    );
    expect(result).toBe('skip-removed');
  });

  it('prioritizes sensitive before excluded', () => {
    const opts = {
      exclude: ['.env', 'secrets/**'],
      isSensitivePath: (p: string) => sensitiveList.has(p),
    };
    const result = classifyFile(
      { path: '.env', status: 'modified', patch: '@@ -1 +1 @@', changes: 1 },
      opts,
    );
    expect(result).toBe('skip-sensitive');
  });

  it('classifies excluded files matching glob patterns as skip-excluded', () => {
    const opts = {
      exclude: ['*.md', 'docs/**', 'vendor/'],
      isSensitivePath: () => false,
    };

    expect(
      classifyFile(
        { path: 'README.md', status: 'modified', patch: '@@ -1 +1 @@', changes: 1 },
        opts,
      ),
    ).toBe('skip-excluded');

    expect(
      classifyFile(
        { path: 'docs/guide.html', status: 'added', patch: '@@ -0,0 +1 @@', changes: 1 },
        opts,
      ),
    ).toBe('skip-excluded');

    expect(
      classifyFile(
        { path: 'vendor/lib/bundle.js', status: 'modified', patch: '@@ -1 +1 @@', changes: 1 },
        opts,
      ),
    ).toBe('skip-excluded');
  });

  it('prioritizes excluded before generated', () => {
    const opts = {
      exclude: ['pnpm-lock.yaml', 'dist/**'],
      isSensitivePath: () => false,
    };

    const result = classifyFile(
      { path: 'pnpm-lock.yaml', status: 'modified', patch: '@@ -1 +1 @@', changes: 10 },
      opts,
    );
    expect(result).toBe('skip-excluded');
  });

  it('classifies lockfiles and generated files as skip-generated', () => {
    const generatedPaths = [
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'bun.lockb',
      'nested/pnpm-lock.yaml',
      'dist/index.js',
      'build/bundle.js',
      'packages/engine/dist/index.d.ts',
      'deep/nested/build/app.css',
      'vendor.min.js',
      'sub/style.min.css',
      'bundle.js.map',
      'types.generated.ts',
      'src/schema.generated.json',
    ];

    for (const p of generatedPaths) {
      const res = classifyFile(
        { path: p, status: 'modified', patch: '@@ -1 +1 @@', changes: 10 },
        defaultOpts,
      );
      expect(res, `expected ${p} to be skip-generated`).toBe('skip-generated');
    }
  });

  it('does not classify files with partial name matches as generated', () => {
    const nonGeneratedPaths = [
      'dist.ts',
      'build.gradle',
      'distance/calc.ts',
      'generated.ts',
      'foo.min.json',
    ];

    for (const p of nonGeneratedPaths) {
      const res = classifyFile(
        { path: p, status: 'modified', patch: '@@ -1 +1 @@', changes: 2 },
        defaultOpts,
      );
      expect(res, `expected ${p} to be review`).toBe('review');
    }
  });

  it('classifies binary files (no patch and changes === 0) as skip-binary', () => {
    const result = classifyFile(
      { path: 'logo.png', status: 'modified', changes: 0 },
      defaultOpts,
    );
    expect(result).toBe('skip-binary');
  });

  it('classifies truncated patch (no patch and changes > 0) as incomplete-truncated', () => {
    const result = classifyFile(
      { path: 'huge-file.ts', status: 'modified', changes: 1250 },
      defaultOpts,
    );
    expect(result).toBe('incomplete-truncated');
  });

  it('classifies normal files with patch as review', () => {
    const result = classifyFile(
      { path: 'src/index.ts', status: 'modified', patch: '@@ -1,3 +1,4 @@', changes: 2 },
      defaultOpts,
    );
    expect(result).toBe('review');
  });
});
