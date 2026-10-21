import { describe, expect, it } from 'vitest';
import { gatherRepositoryContext } from './review-context.js';
import { fakeClient, modified, params } from './review-context.fixtures.js';

// ADR-0041: the context of a change is picked by reference first — the files named on its added
// lines, on the context lines around it and in the pull request description.

describe('referenced repository context (ADR-0041)', () => {
  it('reads a path named on a hunk context line as a referenced file', async () => {
    const { client, reads } = fakeClient({ 'src/a.ts': 'code', 'docs/guide.md': 'guide' });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'),
      patch: '@@ -1,3 +1,3 @@\n const a = 1;\n docs/guide.md\n+const b = 2;',
    }]));

    const guide = result.files.find((f) => f.path === 'docs/guide.md');
    expect(reads.map((r) => r.path)).toContain('docs/guide.md');
    expect(guide?.kind).toBe('referenced');
    expect(guide?.reason).toContain('named near the change in');
  });

  it('sends the code file a changed document names as a referenced file, and its other documents as cited ones', async () => {
    const { client } = fakeClient({ 'notes.md': 'notes', 'src/pay.ts': 'pay', 'docs/other.md': 'other' });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: '@@ -0,0 +1,2 @@\n+See src/pay.ts\n+and docs/other.md',
    }]));

    const pay = result.files.find((f) => f.path === 'src/pay.ts');
    expect(pay?.kind).toBe('referenced');
    expect(pay?.reason).toBe('named in notes.md');
    const other = result.files.find((f) => f.path === 'docs/other.md');
    expect(other?.kind).toBe('cited');
    expect(other?.reason).toBe('cited by notes.md');
  });

  it('sends what the pull request description names, for every reviewed file', async () => {
    const { client } = fakeClient(
      { 'docs/adr/0003-provider-layer.md': 'ADR', 'docs/constitution.md': 'constitution' },
      [],
      { 'docs/adr': ['docs/adr/0003-provider-layer.md'] },
    );
    const result = await gatherRepositoryContext(client, params(
      [modified('src/a.ts'), modified('src/b.ts')],
      { prBody: 'See ADR-0003 and docs/constitution.md' },
    ));

    const adr = result.files.find((f) => f.path === 'docs/adr/0003-provider-layer.md');
    expect(adr?.kind).toBe('referenced');
    expect(adr?.reason).toBe('cited by the pull request description');
    expect(adr?.forPaths).toEqual(['src/a.ts', 'src/b.ts']);
    const doc = result.files.find((f) => f.path === 'docs/constitution.md');
    expect(doc?.kind).toBe('referenced');
    expect(doc?.forPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('scans only the first 4,000 characters of the pull request description', async () => {
    const { client, reads } = fakeClient({ 'docs/late.md': 'late' });
    const result = await gatherRepositoryContext(client, params([modified('src/a.ts')], {
      prBody: `${'x'.repeat(4_000)} docs/late.md`,
    }));

    expect(reads.map((r) => r.path)).not.toContain('docs/late.md');
    expect(result.files.map((f) => f.path)).not.toContain('docs/late.md');
  });

  it('never reads a URL, a secret or an excluded path named in the description', async () => {
    const { client, reads } = fakeClient({ 'docs/x.md': 'x' });
    const result = await gatherRepositoryContext(client, params([modified('src/a.ts')], {
      prBody: 'https://example.com/docs/x.md .env config/.env.production secret/keys.md',
      exclude: ['secret/**'],
    }));

    const read = reads.map((r) => r.path);
    expect(read).not.toContain('docs/x.md');
    expect(read.filter((p) => p.includes('.env'))).toEqual([]);
    expect(read).not.toContain('secret/keys.md');
    expect(result.files.map((f) => f.path)).not.toContain('secret/keys.md');
  });

  it('resolves a spec id to its spec file, with one listing of the specs directory', async () => {
    const { client, reads } = fakeClient({ 'docs/specs/012-pay/spec.md': 'spec' });
    const listings: string[] = [];
    client.listDirectoryFiles = async ({ path }) => {
      listings.push(path);
      return path === 'docs/specs'
        ? ['docs/specs/011-old/', 'docs/specs/012-pay/', 'docs/specs/README.md']
        : [];
    };
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: '@@ -0,0 +1,2 @@\n+See spec 012\n+and specs/012-pay',
    }]));

    expect(result.files.map((f) => f.path)).toContain('docs/specs/012-pay/spec.md');
    expect(reads.filter((r) => r.path === 'docs/specs/012-pay/spec.md')).toHaveLength(1);
    expect(listings).toEqual(['docs/specs', 'specs']);
  });

  it('resolves a spec id to a root specs folder, as spec-kit lays it out', async () => {
    const { client, reads } = fakeClient({ 'specs/012-pay/spec.md': 'spec' });
    client.listDirectoryFiles = async ({ path }) => (path === 'specs' ? ['specs/012-pay/'] : []);
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: '@@ -0,0 +1 @@\n+See spec 012',
    }]));

    expect(result.files.map((f) => f.path)).toEqual(['specs/012-pay/spec.md']);
    expect(reads.map((r) => r.path)).toEqual(['specs/012-pay/spec.md']);
  });

  it('reads nothing for a spec id that has no folder', async () => {
    const { client, reads } = fakeClient({});
    client.listDirectoryFiles = async () => ['docs/specs/011-old/', 'docs/specs/012-pay/'];
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: '@@ -0,0 +1 @@\n+See spec 099',
    }]));

    expect(reads.map((r) => r.path)).toEqual([]);
    expect(result.files.map((f) => f.path)).toEqual([]);
  });

  it('sends the cited file before the sibling test when the read limit is tight', async () => {
    const { client, reads } = fakeClient({ 'src/a.ts': 'code', 'docs/ref.md': 'ref', 'src/a.test.ts': 'test' });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'),
      patch: '@@ -1 +1 @@\n-a\n+see docs/ref.md',
    }], { contextReads: 2 }));

    expect(reads.map((r) => r.path)).toEqual(['src/a.ts', 'docs/ref.md']);
    expect(result.files.map((f) => f.path)).not.toContain('src/a.test.ts');
  });

  it('spends the lookup limit on the added lines before the context lines and the description', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `docs/ref${i}.md`);
    const { client, reads } = fakeClient(Object.fromEntries(paths.map((p) => [p, 'reference'])));
    const result = await gatherRepositoryContext(client, params([{
      ...modified('notes.md'), status: 'added',
      patch: `@@ -0,0 +1 @@\n+${paths.join(' ')}`,
    }], { prBody: 'see docs/late.md' }));

    expect(reads.map((r) => r.path)).toEqual(paths);
    expect(result.leftOut).toEqual(['docs/late.md (cited lookup limit)']);
    expect(result.files.map((f) => f.path)).not.toContain('docs/late.md');
  });

  it('reads an explicit spec path as that path, not as a spec id', async () => {
    const { client, reads } = fakeClient({ 'src/a.ts': 'code', 'specs/012-pay/tasks.md': 'tasks' });
    const listings: string[] = [];
    client.listDirectoryFiles = async ({ path }) => { listings.push(path); return []; };
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'),
      patch: '@@ -1 +1 @@\n-a\n+see specs/012-pay/tasks.md',
    }]));

    expect(reads.map((r) => r.path)).toContain('specs/012-pay/tasks.md');
    expect(result.files.map((f) => f.path)).toContain('specs/012-pay/tasks.md');
    expect(listings).not.toContain('docs/specs');
  });

  it('keeps a description citation of the first reviewed file for the other reviewed files', async () => {
    const { client } = fakeClient({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
    const result = await gatherRepositoryContext(client, params(
      [modified('src/a.ts'), modified('src/b.ts')],
      { prBody: 'see src/a.ts' },
    ));

    const cited = result.files.find((f) => f.path === 'src/a.ts' && f.kind === 'referenced');
    expect(cited?.forPaths ?? []).toContain('src/b.ts');
  });

  it('runs the added-line citations before the description listing takes a read', async () => {
    const { client, reads } = fakeClient({ 'src/a.ts': 'code', 'docs/ref.md': 'ref' }, [], { '': ['README.md'] });
    const result = await gatherRepositoryContext(client, params([{
      ...modified('src/a.ts'),
      patch: '@@ -1 +1 @@\n-a\n+see docs/ref.md',
    }], { prBody: 'README.md', contextReads: 2 }));

    expect(reads.map((r) => r.path)).toEqual(['src/a.ts', 'docs/ref.md']);
    expect(result.leftOut).toContain('(repository root) (not looked up)');
  });
});
