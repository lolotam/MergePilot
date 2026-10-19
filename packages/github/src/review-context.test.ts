import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import {
  gatherRepositoryContext,
  isBuildWiringChange,
  localImportSpecifiers,
  MAX_CONTEXT_READS,
  MAX_WORKFLOW_FILES,
  workflowRunsChanges,
  workspaceManifestCandidates,
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

  it('treats a dotted name that matches an Object.prototype key as an extensionless module', () => {
    expect(() => resolveImportCandidates('src/x.ts', './service.constructor')).not.toThrow();
    expect(resolveImportCandidates('src/x.ts', './service.constructor')[0]).toBe('src/service.constructor.ts');
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
    expect(pairCandidates('app/views_test.py')?.candidates).toEqual(['app/views.py']);
    expect(pairCandidates('README.md')).toBeUndefined();
  });
});

/** A client reading `files` at the head; with `dirs`, it can also list those directories. */
function fakeClient(
  files: Record<string, string>,
  fail: string[] = [],
  dirs?: Record<string, string[]>,
): { client: GitHubClient; reads: Array<{ path: string; ref: string }> } {
  const reads: Array<{ path: string; ref: string }> = [];
  const client = {
    getFileContent: async ({ path, ref }: { path: string; ref: string }) => {
      reads.push({ path, ref });
      if (fail.includes(path)) throw new Error('HTTP 502');
      return ref === 'head-sha' ? (files[path] ?? null) : 'BASE VERSION';
    },
    ...(dirs ? { listDirectoryFiles: async ({ path }: { path: string }) => dirs[path] ?? null } : {}),
  } as unknown as GitHubClient;
  return { client, reads };
}

function params(files: GatherContextParams['files'], overrides: Partial<GatherContextParams> = {}): GatherContextParams {
  return { owner: 'o', repo: 'r', headSha: 'head-sha', files, exclude: [], contextTokens: 30_000, ...overrides };
}

const modified = (path: string) => ({ path, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b', changes: 2 });

describe('gatherRepositoryContext', () => {
  it.each([
    { count: 10, contextReads: 3, contextTokensPerFile: 0, expected: 3 },
    { count: 40, contextReads: 3, contextTokensPerFile: 1, expected: 160 },
    { count: 140, contextReads: 120, contextTokensPerFile: 1, expected: 500 },
  ])('respects and scales the shared read cap: %o', async ({ count, contextReads, contextTokensPerFile, expected }) => {
    const paths = Array.from({ length: count }, (_, i) => `src/f${i}.ts`);
    const { client, reads } = fakeClient(Object.fromEntries(paths.map((p) => [p, 'export const x = 1;'])));
    await gatherRepositoryContext(client, params(paths.map(modified), { contextReads, contextTokensPerFile }));
    expect(reads).toHaveLength(expected);
  });

  it('reads explicit paths and ADR ids from added lines before imports, listing ADRs once', async () => {
    const { client, reads } = fakeClient({
      'src/a.ts': "import './dep.js'; // docs/head-only.md",
      'src/a.test.ts': 'test', 'src/dep.ts': 'dep', 'docs/ref.md': 'reference',
      'docs/adr/0029-repository-context.md': 'ADR',
    }, [], { 'docs/adr': ['docs/adr/0029-repository-context.md'] });
    let listings = 0;
    const list = client.listDirectoryFiles!;
    client.listDirectoryFiles = async (...args) => { listings++; return list(...args); };
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'),
      patch: '@@ -1,2 +1,2 @@\n-docs/removed.md\n docs/unchanged.md\n+docs/ref.md ADR-0029 ADR 0029',
    }]));
    expect(result.files.map((f) => f.kind)).toEqual(['changed-file', 'test-pair', 'cited', 'cited', 'cited', 'import']);
    expect(result.files.find((f) => f.path === 'docs/ref.md')?.reason).toBe('cited by src/a.ts');
    expect(listings).toBe(1);
    expect(reads.some((r) => /removed|unchanged|head-only/.test(r.path))).toBe(false);
    expect(reads.findIndex((r) => r.path === 'docs/ref.md')).toBeLessThan(reads.findIndex((r) => r.path === 'src/dep.ts'));
  });

  it('filters cited paths and caps distinct cited lookups at 20, disclosing overflow and read limits', async () => {
    const paths = Array.from({ length: 22 }, (_, i) => `docs/ref${i}.md`);
    const { client, reads } = fakeClient(Object.fromEntries(paths.map((p) => [p, 'reference'])));
    const changed = { ...modified('notes.md'), status: 'added', patch: `@@ -0,0 +1 @@\n+${paths.join(' ')} .env.local private/secret.ts dist/a.js pnpm-lock.yaml assets/logo.png ../escape.ts` };
    const result = await gatherRepositoryContext(client, params([changed], { exclude: ['private/**'] }));
    expect(reads.map((r) => r.path)).toEqual(paths.slice(0, 20));
    expect(result.leftOut).toEqual(paths.slice(20).map((p) => `${p} (cited lookup limit)`));
    const limited = fakeClient({ 'docs/ref.md': 'reference' });
    const notRead = await gatherRepositoryContext(limited.client, params([
      { ...modified('notes.md'), patch: '@@ -1 +1 @@\n+docs/ref.md' },
    ], { contextReads: 1 }));
    expect(notRead.leftOut).toContain('docs/ref.md (not looked up)');
  });

  it('supports route paths, scoped and Unicode names, and added lines starting with ++', async () => {
    const paths = ['apps/web/(app)/page.tsx', 'app/users/[id]/page.tsx', 'packages/@scope/foo.ts', 'docs/دليل.md'];
    const { client } = fakeClient(Object.fromEntries(paths.map((p) => [p, 'reference'])));
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: `--- a/notes.md\n+++ b/notes.md\n@@ -0,0 +1,3 @@\n+++ [link](${paths[0]})\n+\`${paths[1]}\`\n+${paths.slice(2).join(' ')}`,
    }]));
    expect(result.files.map((f) => f.path)).toEqual(paths);
  });

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

  it('tries the next candidate of a lookup when one is not allowed as context', async () => {
    const { client } = fakeClient({ 'app/tests/test_views.py': 'def test(): pass', 'app/views.py': 'def view(): pass' });
    const result = await gatherRepositoryContext(
      client,
      params([modified('app/tests/test_views.py')], { exclude: ['app/tests/views.py'] }),
    );
    expect(result.files.map((f) => f.path)).toContain('app/views.py');
  });

  it('hands the engine the whole file, so redaction runs before any cut', async () => {
    const big = `${'// filler line\n'.repeat(80_000)}const key = 'tail';`;
    const { client } = fakeClient({ 'src/big.ts': big });
    const result = await gatherRepositoryContext(client, params([modified('src/big.ts')]));
    expect(result.files.find((f) => f.path === 'src/big.ts')?.content).toBe(big);
  });

  it('never takes a failed read or the read limit for file content', async () => {
    const imports = Array.from({ length: MAX_CONTEXT_READS }, (_, i) => `import './m${i}.ts';`).join('\n');
    const { client } = fakeClient({ 'src/api.ts': imports }, ['src/broken.ts']);
    const result = await gatherRepositoryContext(client, params([modified('src/api.ts'), modified('src/broken.ts'), modified('src/late.ts')]));
    expect(result.files.filter((f) => f.content === 'failed' || f.content === 'limit')).toEqual([]);
    expect(result.files.map((f) => f.path)).not.toContain('src/broken.ts');
    expect(result.leftOut).toContain('src/broken.ts (could not be read)');
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

// ADR-0029 amendment: a PR that changes scripts, tests or CI also gets the package manifests and the
// workflows that run them (PayPos#363: the root package.json and ci.yml decided which suites ran).
describe('build and CI wiring', () => {
  it('recognises package manifests, workflows, scripts and tests as build wiring', () => {
    for (const path of ['package.json', 'apps/web/package.json', '.github/workflows/ci.yml', 'scripts/release/run.ts', 'src/lock.test.ts', 'app/tests/conftest.py', 'pkg/store_test.go']) {
      expect(isBuildWiringChange(path), path).toBe(true);
    }
    for (const path of ['src/lock.ts', 'docs/testing.md', 'src/contest.ts', 'app/views.py']) {
      expect(isBuildWiringChange(path), path).toBe(false);
    }
  });

  it('looks for the nearest workspace manifest at most two directories deep', () => {
    expect(workspaceManifestCandidates('apps/admin/src/orders/x.spec.tsx')).toEqual(['apps/admin/package.json', 'apps/package.json']);
    expect(workspaceManifestCandidates('scripts/check.sh')).toEqual(['scripts/package.json']);
    expect(workspaceManifestCandidates('package.json')).toEqual([]);
    expect(workspaceManifestCandidates('.github/workflows/ci.yml')).toEqual([]);
  });

  it('keeps a workflow only when it runs package scripts or names a changed file', () => {
    expect(workflowRunsChanges('steps:\n  - run: pnpm check', ['src/a.test.ts'])).toBe(true);
    expect(workflowRunsChanges('steps:\n  - run: ./scripts/gate.sh', ['scripts/gate.sh'])).toBe(true);
    expect(workflowRunsChanges('steps:\n  - uses: actions/labeler@v5', ['src/a.test.ts'])).toBe(false);
  });

  it('sends the root and workspace manifests and the workflows that run the changed tests', async () => {
    const { client, reads } = fakeClient(
      {
        'apps/admin/src/x.spec.tsx': 'it("works", () => {});',
        'package.json': '{ "scripts": { "test": "vitest run" } }',
        'apps/admin/package.json': '{ "scripts": { "test": "vitest run src" } }',
        '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: pnpm test',
        '.github/workflows/labeler.yml': 'jobs:\n  label:\n    steps:\n      - uses: actions/labeler@v5',
      },
      [],
      { '.github/workflows': ['.github/workflows/labeler.yml', '.github/workflows/ci.yml', '.github/workflows/README.md'] },
    );
    const result = await gatherRepositoryContext(client, params([modified('apps/admin/src/x.spec.tsx')]));

    expect(result.files.filter((f) => f.kind === 'build-config').map((f) => [f.path, f.reason, f.forPaths])).toEqual([
      ['package.json', 'root package manifest (scripts)', ['apps/admin/src/x.spec.tsx']],
      ['apps/admin/package.json', 'workspace package manifest (scripts)', ['apps/admin/src/x.spec.tsx']],
      ['.github/workflows/ci.yml', 'CI workflow that runs the scripts', ['apps/admin/src/x.spec.tsx']],
    ]);
    expect(reads.map((r) => r.path)).not.toContain('.github/workflows/README.md');
    expect(reads.every((r) => r.ref === 'head-sha')).toBe(true);
  });

  it('reads manifests before listing workflows when only two reads remain', async () => {
    const imports = Array.from({ length: MAX_CONTEXT_READS - 4 }, (_, i) => `import './m${i}.ts';`).join('\n');
    const { client, reads } = fakeClient({
      'apps/admin/x.test.ts': imports,
      'package.json': '{}',
      'apps/admin/package.json': '{}',
    }, [], { '.github/workflows': ['.github/workflows/ci.yml'] });
    const result = await gatherRepositoryContext(client, params([modified('apps/admin/x.test.ts')]));
    expect(reads).toHaveLength(MAX_CONTEXT_READS);
    expect(result.files.filter((f) => f.kind === 'build-config').map((f) => f.path)).toEqual([
      'package.json', 'apps/admin/package.json',
    ]);
    expect(result.leftOut).toContain('.github/workflows/ (not looked up)');
  });

  it('reads each distinct manifest and workflow once across many triggers without exhausting the budget', async () => {
    const paths = Array.from({ length: MAX_CONTEXT_READS }, (_, i) => `tests/case${i}.sh`);
    const { client, reads } = fakeClient({
      'package.json': '{}',
      'tests/package.json': '{}',
      '.github/workflows/ci.yml': 'run: pnpm test',
    }, [], { '.github/workflows': ['.github/workflows/ci.yml'] });
    const result = await gatherRepositoryContext(client, params(paths.map((path) => ({
      path, status: 'added', patch: '@@ -0,0 +1 @@\n+echo test', changes: 1,
    }))));
    expect(reads.map((r) => r.path).sort()).toEqual([
      '.github/workflows/ci.yml', 'package.json', 'tests/package.json',
    ]);
    for (const path of ['package.json', 'tests/package.json', '.github/workflows/ci.yml']) {
      expect(result.files.filter((f) => f.path === path).flatMap((f) => f.forPaths)).toEqual(paths);
    }
    expect(result.leftOut).toEqual([]);
  });

  it('associates workflows with each relevant path rather than every trigger', async () => {
    const { client } = fakeClient({
      '.github/workflows/deploy.yml': 'run: ./scripts/deploy.sh',
      '.github/workflows/ci.yml': 'run: pnpm check',
    }, [], { '.github/workflows': ['.github/workflows/deploy.yml', '.github/workflows/ci.yml'] });
    const paths = ['scripts/deploy.sh', 'tests/smoke.sh', 'package.json'];
    const result = await gatherRepositoryContext(client, params(paths.map((path) => ({
      path, status: 'added', patch: '@@ -0,0 +1 @@\n+content', changes: 1,
    }))));
    expect(result.files.filter((f) => f.path === '.github/workflows/deploy.yml').flatMap((f) => f.forPaths)).toEqual(['scripts/deploy.sh']);
    expect(result.files.filter((f) => f.path === '.github/workflows/ci.yml').flatMap((f) => f.forPaths)).toEqual(paths);
  });

  it('adds no build wiring to a PR that changes no script, test or CI file', async () => {
    const { client, reads } = fakeClient({ 'src/api.ts': 'export const a = 1;', 'package.json': '{}' }, [], {
      '.github/workflows': ['.github/workflows/ci.yml'],
    });
    const result = await gatherRepositoryContext(client, params([modified('src/api.ts')]));

    expect(result.files.some((f) => f.kind === 'build-config')).toBe(false);
    expect(reads.map((r) => r.path)).not.toContain('package.json');
  });

  it('discloses workflows past the per-review limit', async () => {
    const names = Array.from({ length: MAX_WORKFLOW_FILES + 2 }, (_, i) => `.github/workflows/w${String(i).padStart(2, '0')}.yml`);
    const { client } = fakeClient({ 'src/a.test.ts': 'x' }, [], { '.github/workflows': names });
    const result = await gatherRepositoryContext(client, params([modified('src/a.test.ts')]));

    expect(result.leftOut).toEqual(names.slice(MAX_WORKFLOW_FILES).map((n) => `${n} (not looked up)`));
  });

  it('still sends the manifests when the client cannot list directories', async () => {
    const { client } = fakeClient({ 'src/a.test.ts': 'x', 'package.json': '{}' });
    const result = await gatherRepositoryContext(client, params([modified('src/a.test.ts')]));

    expect(result.files.filter((f) => f.kind === 'build-config').map((f) => f.path)).toEqual(['package.json']);
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
