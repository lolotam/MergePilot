import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import {
  gatherRepositoryContext,
  localImportSpecifiers,
  MAX_CONTEXT_READS,
  pairCandidates,
  pythonImportCandidates,
  resolveImportCandidates,
  type GatherContextParams,
} from './review-context.js';
import { mergeContextDisclosures, renderContextNote } from './review-notes.js';

// ADR-0029: the gatherer finds a reviewed file's full version, its test or implementation, and its
// local imports, reading at the PR head through the shared per-client cache.

describe('import resolution', () => {
  it('keeps only relative specifiers of imports, re-exports, dynamic imports and require', () => {
    const source = [
      "import { a } from './a.js';",
      "import type { B } from '../types/b';",
      "export * from './c.js';",
      "import './side-effect';",
      "const d = await import('./d.js');",
      "const e = require('./e');",
      "import { z } from 'zod';",
      "import fs from 'node:fs';",
      "import { x } from '@scope/pkg/sub';",
    ].join('\n');
    expect(localImportSpecifiers(source)).toEqual(['./a.js', '../types/b', './c.js', './side-effect', './d.js', './e']);
  });

  it('maps .js to the TypeScript source first and tries index files for a directory', () => {
    expect(resolveImportCandidates('src/review/x.ts', './lock.js')).toEqual([
      'src/review/lock.ts',
      'src/review/lock.tsx',
      'src/review/lock.js',
    ]);
    expect(resolveImportCandidates('src/review/x.ts', '../config')).toEqual([
      'src/config.ts',
      'src/config.tsx',
      'src/config.js',
      'src/config.jsx',
      'src/config/index.ts',
      'src/config/index.tsx',
      'src/config/index.js',
    ]);
    expect(resolveImportCandidates('src/x.ts', './user.service')[0]).toBe('src/user.service.ts');
  });

  it('ignores asset imports and paths that climb above the repository root', () => {
    expect(resolveImportCandidates('src/x.ts', './styles.css')).toEqual([]);
    expect(resolveImportCandidates('src/x.ts', '../../outside.js')).toEqual([]);
  });

  it('resolves Python relative imports to a module file or its package', () => {
    const source = 'from .models import User\nfrom ..core.db import session\nfrom . import utils, helpers as h\nimport os';
    expect(pythonImportCandidates('app/api/views.py', source)).toEqual([
      ['app/api/models.py', 'app/api/models/__init__.py'],
      ['app/core/db.py', 'app/core/db/__init__.py'],
      ['app/api/utils.py', 'app/api/utils/__init__.py'],
      ['app/api/helpers.py', 'app/api/helpers/__init__.py'],
    ]);
  });
});

describe('pairCandidates', () => {
  it('finds the test of an implementation and the implementation of a test', () => {
    expect(pairCandidates('src/lock.ts')).toEqual({
      candidates: ['src/lock.test.ts', 'src/lock.spec.ts', 'src/__tests__/lock.test.ts'],
      reason: 'test of src/lock.ts',
    });
    expect(pairCandidates('src/lock.spec.tsx')?.candidates).toEqual(['src/lock.tsx']);
    expect(pairCandidates('src/__tests__/lock.test.ts')?.candidates).toEqual(['src/lock.ts']);
    expect(pairCandidates('pkg/store.go')?.candidates).toEqual(['pkg/store_test.go']);
    expect(pairCandidates('app/tests/test_views.py')?.candidates).toEqual(['app/tests/views.py', 'app/views.py']);
    expect(pairCandidates('README.md')).toBeUndefined();
  });
});

function fakeClient(files: Record<string, string>, fail: string[] = []): { client: GitHubClient; reads: Array<{ path: string; ref: string }> } {
  const reads: Array<{ path: string; ref: string }> = [];
  const client = {
    getFileContent: async ({ path, ref }: { path: string; ref: string }) => {
      reads.push({ path, ref });
      if (fail.includes(path)) throw new Error('HTTP 502');
      return ref === 'head-sha' ? (files[path] ?? null) : 'BASE VERSION';
    },
  } as unknown as GitHubClient;
  return { client, reads };
}

function params(files: GatherContextParams['files'], overrides: Partial<GatherContextParams> = {}): GatherContextParams {
  return { owner: 'o', repo: 'r', headSha: 'head-sha', files, exclude: [], contextTokens: 30_000, ...overrides };
}

const modified = (path: string) => ({ path, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', changes: 2 });

describe('gatherRepositoryContext', () => {
  it('reads the full file, its test and its imports at the head commit', async () => {
    const { client, reads } = fakeClient({
      'src/api.ts': "import { lock } from './lock.js';\nimport { z } from 'zod';",
      'src/lock.ts': 'export function lock() {}',
      'src/api.test.ts': 'it("works", () => {});',
    });
    const result = await gatherRepositoryContext(client, params([modified('src/api.ts')]));

    expect(reads.every((r) => r.ref === 'head-sha')).toBe(true);
    expect(result.files.map((f) => [f.path, f.kind, f.reason])).toEqual([
      ['src/api.ts', 'changed-file', 'changed file, full version'],
      ['src/api.test.ts', 'test-pair', 'test of src/api.ts'],
      ['src/lock.ts', 'import', 'imported by src/api.ts'],
    ]);
    expect(result.leftOut).toEqual([]);
  });

  it('shares reads per client, so a second bot of the panel reads nothing again', async () => {
    const { client, reads } = fakeClient({ 'src/api.ts': "import './lock.js';", 'src/lock.ts': 'x' });
    await gatherRepositoryContext(client, params([modified('src/api.ts')]));
    const first = reads.length;
    const second = await gatherRepositoryContext(client, params([modified('src/api.ts')]));

    expect(reads).toHaveLength(first);
    expect(second.files.map((f) => f.path)).toContain('src/lock.ts');
  });

  it('never reads sensitive, excluded, lock or generated files, nor removed or added ones', async () => {
    const { client, reads } = fakeClient({
      'src/api.ts': "import './.env';\nimport './legacy/old.js';\nimport '../dist/out.js';",
      'src/new.ts': 'export const fresh = 1;',
    });
    await gatherRepositoryContext(
      client,
      params(
        [
          modified('src/api.ts'),
          { path: 'src/gone.ts', status: 'removed', changes: 3 },
          { path: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const fresh = 1;', changes: 1 },
          modified('certs/server.pem'),
          modified('pnpm-lock.yaml'),
        ],
        { exclude: ['src/legacy/**'] },
      ),
    );
    const readPaths = reads.map((r) => r.path);
    expect(readPaths).toContain('src/api.ts');
    expect(readPaths.filter((p) => /\.env|legacy|dist\/|gone|\.pem|lock\.yaml|^src\/new\.ts$/.test(p))).toEqual([]);
  });

  it('does not read a changed file that context may not hold (vendor, out/, node_modules)', async () => {
    const { client, reads } = fakeClient({ 'vendor/lib.ts': 'x', 'out/generated.ts': 'y', 'src/api.ts': 'z' });
    await gatherRepositoryContext(client, params([modified('vendor/lib.ts'), modified('out/generated.ts'), modified('src/api.ts')]));
    const readPaths = reads.map((r) => r.path);
    expect(readPaths).toContain('src/api.ts');
    expect(readPaths.filter((p) => p.startsWith('vendor/') || p.startsWith('out/'))).toEqual([]);
  });

  it("offers an added file's patch as the import context of the file importing it, without a read", async () => {
    const { client, reads } = fakeClient({ 'src/api.ts': "import { fresh } from './new.js';" });
    const result = await gatherRepositoryContext(
      client,
      params([
        modified('src/api.ts'),
        { path: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+export const fresh = 1;', changes: 1 },
      ]),
    );
    expect(result.files.find((f) => f.path === 'src/new.ts')).toMatchObject({ kind: 'import', content: 'export const fresh = 1;' });
    expect(reads.map((r) => r.path)).not.toContain('src/new.ts');
  });

  it('counts imports past the read limit and failed reads as left out', async () => {
    const imports = Array.from({ length: MAX_CONTEXT_READS }, (_, i) => `import './m${i}.ts';`).join('\n');
    const { client } = fakeClient({ 'src/api.ts': imports }, ['src/m0.ts']);
    const result = await gatherRepositoryContext(client, params([modified('src/api.ts')]));

    expect(result.leftOut).toContain('src/m0.ts (could not be read)');
    expect(result.leftOut.filter((p) => p.endsWith('(not looked up)')).length).toBeGreaterThan(0);
  });

  it('reads nothing when review.contextTokens is 0', async () => {
    const { client, reads } = fakeClient({ 'src/api.ts': "import './lock.js';" });
    const result = await gatherRepositoryContext(client, params([modified('src/api.ts')], { contextTokens: 0 }));
    expect(result).toEqual({ files: [], leftOut: [] });
    expect(reads).toEqual([]);
  });
});

describe('context disclosure', () => {
  it('says how many files were sent and left out, in English and Arabic', () => {
    const context = { sent: ['a.ts', 'b.ts'], leftOut: ['c.ts'] };
    expect(renderContextNote(context, false)).toBe(
      '> ℹ️ Repository context: 2 files sent, 1 left out (over `review.contextTokens` or the read limit).',
    );
    expect(renderContextNote(context, true)).toContain('سياق المستودع: الملفات المُرسلة 2، وغير المُرسلة 1');
    expect(renderContextNote({ sent: [], leftOut: [] }, false)).toBeUndefined();
  });

  it('merges panel bots: a file any bot sent is not left out', () => {
    expect(
      mergeContextDisclosures([{ sent: ['a.ts'], leftOut: ['b.ts'] }, { sent: ['b.ts'], leftOut: ['c.ts'] }, undefined]),
    ).toEqual({ sent: ['a.ts', 'b.ts'], leftOut: ['c.ts'] });
  });
});
