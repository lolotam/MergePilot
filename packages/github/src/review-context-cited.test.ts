import { describe, expect, it } from 'vitest';
import { gatherRepositoryContext } from './review-context.js';
import { fakeClient, modified, params } from './review-context.fixtures.js';

describe('cited repository context', () => {
  it('rejects code, prose and URLs before they consume citation slots or reads', async () => {
    const junk = [
      'this.opts.contextTokens', 'Math.min', 'config.review.contextReads',
      'z.number().int().min(1).max(500).default', 'e.g', 'www.example.com',
      'https://www.example.com/docs/fake.md', 'www.example.com/docs/fake.md',
      'call(docs/fake.md)', 'docs/(bad).call/fake.md', 'docs/name[bad]/fake.md',
      'this.config.json',
      ...Array.from({ length: 25 }, (_, i) => `object${i}.property`),
    ];
    const { client, reads } = fakeClient({ 'docs/real.md': 'reference', 'src/dep.ts': 'dependency' });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'), status: 'added',
      patch: `@@ -0,0 +1,3 @@\n+${junk.map((s) => `\`${s}\``).join(' ')}\n+docs/real.md\n+import './dep.js';`,
    }], { contextReads: 5 }));
    expect(reads.map((r) => r.path)).toEqual(['src/a.test.ts', 'src/a.spec.ts', 'src/__tests__/a.test.ts', 'docs/real.md', 'src/dep.ts']);
    expect(result.files.map((f) => [f.path, f.kind])).toEqual([['docs/real.md', 'cited'], ['src/dep.ts', 'import']]);
    expect(result.leftOut).toEqual([]);
  });

  it('accepts explicit paths and listed root documentation files, listing the root once at head', async () => {
    const paths = ['docs/adr/0029-repository-context.md', 'packages/x/src/y.ts', 'AGENTS.md', 'app/(shop)/page.tsx'];
    const { client, reads } = fakeClient(Object.fromEntries(paths.map((p) => [p, 'reference'])));
    const listings: Array<{ path: string; ref: string }> = [];
    client.listDirectoryFiles = async ({ path, ref }) => { listings.push({ path, ref }); return ['AGENTS.md', 'root.ts']; };
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: `@@ -0,0 +1 @@\n+${paths.join(' ')} \`AGENTS.md\` MISSING.md root.ts`,
    }]));
    expect(result.files.map((f) => f.path).sort()).toEqual([...paths, 'AGENTS.md'].sort());
    expect(reads.map((r) => r.path)).toEqual(paths);
    expect(listings).toEqual([{ path: '', ref: 'head-sha' }]);
  });

  it('reads cited 404s once per distinct path and stops them at 20 while preserving import reads', async () => {
    const paths = Array.from({ length: 30 }, (_, i) => `docs/missing${i}.md`);
    const { client, reads } = fakeClient({ 'src/dep.ts': 'dependency' });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'), status: 'added',
      patch: `@@ -0,0 +1,2 @@\n+${paths.flatMap((p) => [p, p]).join(' ')}\n+import './dep.js';`,
    }], { contextReads: 24 }));
    expect(reads.filter((r) => r.path.startsWith('docs/')).map((r) => r.path)).toEqual(paths.slice(0, 20));
    expect(reads).toHaveLength(24);
    expect(result.files).toContainEqual(expect.objectContaining({ path: 'src/dep.ts', kind: 'import' }));
  });

  it('accepts only listed root files for every supported documentation/config extension', async () => {
    const paths = ['md', 'mdx', 'txt', 'yml', 'yaml', 'json', 'toml', 'sql'].map((ext) => `settings.${ext}`);
    const { client, reads } = fakeClient(Object.fromEntries(paths.map((p) => [p, 'reference'])), [], { '': paths });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added', patch: `@@ -0,0 +1 @@\n+${paths.join(' ')}`,
    }]));
    expect(result.files.map((f) => f.path)).toEqual(paths);
    expect(reads.map((r) => r.path)).toEqual(paths);
  });

});
