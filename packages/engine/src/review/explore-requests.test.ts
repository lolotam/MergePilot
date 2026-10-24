/**
 * The requests of an exploration round (ADR-0046): the paths the rules refuse, the reads that
 * are cut to the budget, the searches and the listings.
 */

import { describe, expect, it } from 'vitest';
import type { ExploreLimits } from '../config/schema.js';
import { Secret } from '../credentials/secret.js';
import { isContextPathAllowed } from '../diff/classify-file.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { estimateTokens } from './budget.js';
import { ExploreBudget, type RepositoryReader } from './explore.js';
import { executeRequests, type ExploreRequest } from './explore-requests.js';

const LIMITS: ExploreLimits = {
  maxRounds: 3,
  maxRequestsPerRound: 8,
  maxReadTokens: 30_000,
  maxLinesPerRead: 400,
};

const EXCLUDE = ['**/secret/**'];

const allowPath = (path: string): boolean =>
  isContextPathAllowed(path, { exclude: EXCLUDE, isSensitivePath });

interface FakeReader extends RepositoryReader {
  reads: string[];
  listings: string[];
  listCalls: number;
}

function fakeReader(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
  listing: string[] | null = null,
  truncated = false,
): FakeReader {
  const reads: string[] = [];
  const listings: string[] = [];
  const reader: FakeReader = {
    reads,
    listings,
    listCalls: 0,
    async readFile(path) {
      reads.push(path);
      return files[path] ?? null;
    },
    async listDirectory(dir) {
      listings.push(dir);
      return dirs[dir] ?? null;
    },
    async listPaths() {
      reader.listCalls += 1;
      return listing === null ? null : { paths: listing, truncated };
    },
  };
  return reader;
}

function ctx(
  reader: RepositoryReader,
  budget: ExploreBudget,
  heldFiles: Record<string, string> = {},
  patches: readonly string[] = [],
  limits: ExploreLimits = LIMITS,
  knownSecrets: readonly Secret[] = [],
): Parameters<typeof executeRequests>[1] {
  return {
    reader,
    budget,
    limits,
    allowPath,
    // Every held text is a source of its own: the paths in `patches` hold a unified patch.
    heldTexts: {
      sources: Object.entries(heldFiles).map(([path, text]) => ({
        path,
        text,
        isPatch: patches.includes(path),
      })),
    },
    knownSecrets,
  };
}

describe('the requests of an exploration round (ADR-0046)', () => {
  it('refuses the paths the rules and the path rules forbid, and never reads them', async () => {
    const reader = fakeReader();
    const budget = new ExploreBudget(LIMITS);
    const requests: ExploreRequest[] = [
      { read: { path: '../outside.ts' } },
      { read: { path: '/etc/passwd' } },
      { read: { path: 'C:/Windows/system.ini' } },
      { read: { path: '.git/config' } },
      { read: { path: '.env' } },
      { read: { path: 'src/secret/key.ts' } },
    ];

    const result = await executeRequests(requests, ctx(reader, budget));

    expect(result.refused).toBe(6);
    expect(reader.reads).toEqual([]);
    for (const entry of result.entries) {
      expect(entry.content).toBe('not allowed');
      expect(entry.label.startsWith('refused: ')).toBe(true);
    }
  });

  it('refuses a search and a listing whose path the rules forbid', async () => {
    const reader = fakeReader();
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests(
      [{ find: { text: 'x', path: '../outside' } }, { list: { dir: '.git' } }],
      ctx(reader, budget),
    );

    expect(result.refused).toBe(2);
    expect(reader.listings).toEqual([]);
  });

  it('reads a line range with its line numbers and charges the budget', async () => {
    const reader = fakeReader({ 'src/a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;' });
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests([{ read: { path: 'src/a.ts', startLine: 2, endLine: 3 } }], ctx(reader, budget));

    expect(result.entries[0]!.content).toBe('2| const b = 2;\n3| const c = 3;');
    expect(budget.remainingTokens).toBeLessThan(LIMITS.maxReadTokens);
    expect(budget.filesRead).toEqual(['src/a.ts']);
  });

  it('says not found for a file the reader does not have', async () => {
    const reader = fakeReader();
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests([{ read: { path: 'src/missing.ts' } }], ctx(reader, budget));

    expect(result.entries[0]!.content).toBe('not found');
    expect(result.refused).toBe(0);
  });

  it('caps a read at the lines one read may return', async () => {
    const content = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n');
    const reader = fakeReader({ 'src/a.ts': content });
    const budget = new ExploreBudget({ ...LIMITS, maxLinesPerRead: 20 });

    const result = await executeRequests([{ read: { path: 'src/a.ts' } }], ctx(reader, budget, {}, [], { ...LIMITS, maxLinesPerRead: 20 }));

    expect(result.entries[0]!.content.split('\n')).toHaveLength(20);
    expect(result.entries[0]!.content.startsWith('1| line 1')).toBe(true);
  });

  it('cuts a read that does not fit the remaining budget and says so', async () => {
    const content = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const reader = fakeReader({ 'src/a.ts': content });
    const budget = new ExploreBudget({ ...LIMITS, maxReadTokens: 1000 });

    const result = await executeRequests([{ read: { path: 'src/a.ts' } }], ctx(reader, budget));

    expect(result.entries[0]!.content).toContain('… (cut to the read budget)');
    expect(budget.remainingTokens).toBeGreaterThanOrEqual(0);
    expect(budget.remainingTokens).toBeLessThan(1000);
  });

  it('serves the same range of a file read before from what was read, without charging again', async () => {
    const reader = fakeReader({ 'src/a.ts': 'const a = 1;\nconst b = 2;' });
    const budget = new ExploreBudget(LIMITS);

    await executeRequests([{ read: { path: 'src/a.ts', startLine: 1, endLine: 2 } }], ctx(reader, budget));
    const left = budget.remainingTokens;
    const second = await executeRequests(
      [{ read: { path: 'src/a.ts', startLine: 1, endLine: 2 } }],
      ctx(reader, budget),
    );

    expect(budget.remainingTokens).toBe(left);
    expect(reader.reads).toEqual(['src/a.ts']);
    expect(second.entries[0]!.content).toBe('1| const a = 1;\n2| const b = 2;');
  });

  it('serves a repeated read with the content it showed the first time', async () => {
    const readBudget = 1000;
    const content = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const reader = fakeReader({ 'src/a.ts': content });
    const budget = new ExploreBudget({ ...LIMITS, maxReadTokens: readBudget });

    const result = await executeRequests(
      [{ read: { path: 'src/a.ts' } }, { read: { path: 'src/a.ts' } }],
      ctx(reader, budget),
    );

    // The read was cut to the budget: the repeat shows the same cut, and it is free.
    expect(result.entries[0]!.content).toContain('… (cut to the read budget)');
    expect(result.entries[0]!.content).not.toContain('const value399');
    expect(result.entries[1]!.content).toBe(result.entries[0]!.content);
    expect(readBudget - budget.remainingTokens).toBe(estimateTokens(result.entries[0]!.content));
  });

  it('charges another range of a file that was read before', async () => {
    const reader = fakeReader({ 'src/a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;' });
    const budget = new ExploreBudget(LIMITS);

    await executeRequests([{ read: { path: 'src/a.ts', startLine: 1, endLine: 1 } }], ctx(reader, budget));
    const left = budget.remainingTokens;
    const second = await executeRequests(
      [{ read: { path: 'src/a.ts', startLine: 1, endLine: 3 } }],
      ctx(reader, budget),
    );

    expect(budget.remainingTokens).toBeLessThan(left);
    // The content was read once; only the new range is charged.
    expect(reader.reads).toEqual(['src/a.ts']);
    expect(second.entries[0]!.content).toBe('1| const a = 1;\n2| const b = 2;\n3| const c = 3;');
  });

  it('stops with one entry when the read budget is used up', async () => {
    const reader = fakeReader({ 'src/a.ts': 'const a = 1;' });
    const budget = new ExploreBudget(LIMITS);
    budget.charge(LIMITS.maxReadTokens);

    const result = await executeRequests(
      [{ read: { path: 'src/a.ts' } }, { read: { path: 'src/b.ts' } }],
      ctx(reader, budget),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.content).toBe('read budget used up');
    expect(reader.reads).toEqual([]);
  });

  it('searches the files the review holds and the files it read', async () => {
    const reader = fakeReader({ 'src/read.ts': 'const found = 1;\nconst other = 2;' });
    const budget = new ExploreBudget(LIMITS);
    const held = { 'src/held.ts': 'const found = 0;' };

    await executeRequests([{ read: { path: 'src/read.ts' } }], ctx(reader, budget, held));
    const result = await executeRequests([{ find: { text: 'found' } }], ctx(reader, budget, held));

    expect(result.entries[0]!.content).toContain('src/held.ts:1: const found = 0;');
    expect(result.entries[0]!.content).toContain('src/read.ts:1: const found = 1;');
  });

  it('searches a file that was read once, not twice', async () => {
    const reader = fakeReader({ 'src/read.ts': 'const found = 1;' });
    const budget = new ExploreBudget(LIMITS);
    const held = { 'src/read.ts': 'const found = 0;' };

    await executeRequests([{ read: { path: 'src/read.ts' } }], ctx(reader, budget, held));
    const result = await executeRequests([{ find: { text: 'found' } }], ctx(reader, budget, held));

    // The held head file of the path is searched once, through the file that was read.
    expect(result.entries[0]!.content).toBe('src/read.ts:1: const found = 1;');
  });

  it('searches the patch of a path that was read, beside the file that was read', async () => {
    const reader = fakeReader({ 'src/read.ts': 'const found = 1;' });
    const budget = new ExploreBudget(LIMITS);
    const patch = ['@@ -1,1 +40,1 @@', '+const found = 2;'].join('\n');
    const held = { 'src/read.ts': patch };

    await executeRequests([{ read: { path: 'src/read.ts' } }], ctx(reader, budget, held, ['src/read.ts']));
    const result = await executeRequests([{ find: { text: 'found' } }], ctx(reader, budget, held, ['src/read.ts']));

    // The patch is the change itself: it is searched beside the file that was read.
    expect(result.entries[0]!.content).toContain('src/read.ts:40: const found = 2;');
    expect(result.entries[0]!.content).toContain('src/read.ts:1: const found = 1;');
  });

  it('limits a search to the paths that start with the given prefix', async () => {
    const reader = fakeReader();
    const budget = new ExploreBudget(LIMITS);
    const held = {
      'src/a.ts': 'const found = 1;',
      'lib/b.ts': 'const found = 2;',
    };

    const result = await executeRequests([{ find: { text: 'found', path: 'src/' } }], ctx(reader, budget, held));

    expect(result.entries[0]!.content).toContain('src/a.ts:1');
    expect(result.entries[0]!.content).not.toContain('lib/b.ts');
  });

  it('lists the paths of the head that match the search', async () => {
    const reader = fakeReader({}, {}, ['src/guard.ts', 'src/other.ts', 'lib/guard.ts']);
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests([{ find: { text: 'guard' } }], ctx(reader, budget));

    expect(result.entries[0]!.content).toContain('src/guard.ts');
    expect(result.entries[0]!.content).toContain('lib/guard.ts');
    expect(result.entries[0]!.content).not.toContain('src/other.ts');
    expect(reader.listCalls).toBe(1);
  });

  it('lists the allowed entries of a directory only', async () => {
    const reader = fakeReader({}, { 'src': ['src/a.ts', 'src/secret/key.ts', 'src/.env'] });
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests([{ list: { dir: 'src' } }], ctx(reader, budget));

    expect(result.entries[0]!.content).toBe('src/a.ts');
    expect(reader.listings).toEqual(['src']);
  });

  it('cuts a search that does not fit the remaining budget and says so', async () => {
    const reader = fakeReader();
    const budget = new ExploreBudget({ ...LIMITS, maxReadTokens: 1000 });
    const held = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`src/f${index}.ts`, `const found = ${index}; ${'x'.repeat(180)}`]),
    );

    const result = await executeRequests([{ find: { text: 'found' } }], ctx(reader, budget, held));

    expect(result.entries[0]!.content).toContain('… (cut to the read budget)');
    expect(budget.remainingTokens).toBeGreaterThanOrEqual(0);
  });

  it('cuts a listing that does not fit the remaining budget and says so', async () => {
    const entries = Array.from({ length: 200 }, (_, index) => `src/deep/nested/directory/file${index}.ts`);
    const reader = fakeReader({}, { 'src': entries });
    const budget = new ExploreBudget({ ...LIMITS, maxReadTokens: 1000 });

    const result = await executeRequests([{ list: { dir: 'src' } }], ctx(reader, budget));

    expect(result.entries[0]!.content).toContain('… (cut to the read budget)');
    expect(budget.remainingTokens).toBeGreaterThanOrEqual(0);
  });

  it('answers a failed read with "read failed" and goes on with the next request', async () => {
    const reader: RepositoryReader = {
      async readFile() {
        throw new Error('the rate limit is over');
      },
      async listDirectory() {
        return null;
      },
      async listPaths() {
        return null;
      },
    };
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests(
      [{ read: { path: 'src/a.ts' } }, { list: { dir: 'src' } }],
      ctx(reader, budget),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.content).toBe('read failed');
    expect(result.entries[0]!.content).not.toContain('the rate limit is over');
    expect(result.entries[1]!.content).toBe('not found');
    expect(result.refused).toBe(0);
  });

  it('answers a failed listing with "read failed" and goes on with the next request', async () => {
    const reader: RepositoryReader = {
      async readFile() {
        return null;
      },
      async listDirectory() {
        throw new Error('the server is down');
      },
      async listPaths() {
        return null;
      },
    };
    const budget = new ExploreBudget(LIMITS);

    const result = await executeRequests(
      [{ list: { dir: 'src' } }, { read: { path: 'src/a.ts' } }],
      ctx(reader, budget),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.content).toBe('read failed');
    expect(result.entries[0]!.content).not.toContain('the server is down');
    expect(result.entries[1]!.content).toBe('not found');
  });

  it('keeps the matches the review holds when the path listing fails', async () => {
    const reader: RepositoryReader = {
      async readFile() {
        return null;
      },
      async listDirectory() {
        return null;
      },
      async listPaths() {
        throw new Error('the server is down');
      },
    };
    const budget = new ExploreBudget(LIMITS);
    const held = { 'src/held.ts': 'const found = 1;' };

    const result = await executeRequests(
      [{ find: { text: 'found' } }, { read: { path: 'src/a.ts' } }],
      ctx(reader, budget, held),
    );

    expect(result.entries).toHaveLength(2);
    // The failed listing costs the paths of the head only: the matches stay.
    expect(result.entries[0]!.content).toContain('src/held.ts:1: const found = 1;');
    expect(result.entries[0]!.content).not.toContain('the server is down');
    expect(result.entries[1]!.content).toBe('not found');
  });

  it('tries the path listing again after a failed one', async () => {
    let calls = 0;
    const reader: RepositoryReader = {
      async readFile() {
        return null;
      },
      async listDirectory() {
        return null;
      },
      async listPaths() {
        calls += 1;
        if (calls === 1) throw new Error('the server is down');
        return { paths: ['src/guard.ts'], truncated: false };
      },
    };
    const budget = new ExploreBudget(LIMITS);

    const first = await executeRequests([{ find: { text: 'guard' } }], ctx(reader, budget));
    const second = await executeRequests([{ find: { text: 'guard' } }], ctx(reader, budget));

    expect(calls).toBe(2);
    expect(first.entries[0]!.content).toBe('');
    expect(second.entries[0]!.content).toContain('src/guard.ts');
  });

  it('redacts a secret before the line cut, so no part of it is shown', async () => {
    const secret = new Secret('explore-secret-one\nexplore-secret-two');
    // The secret sits on the twentieth line and runs into the twenty-first: a read cut at twenty
    // lines would show its first half.
    const lines = Array.from({ length: 19 }, (_, index) => `const value${index} = ${index};`);
    const reader = fakeReader({
      'src/a.ts': [...lines, `const key = "${secret.reveal()}";`, 'const after = 1;'].join('\n'),
    });
    const budget = new ExploreBudget(LIMITS);
    const limits = { ...LIMITS, maxLinesPerRead: 20 };

    const result = await executeRequests(
      [{ read: { path: 'src/a.ts' } }],
      ctx(reader, budget, {}, [], limits, [secret]),
    );

    expect(result.entries[0]!.content).toContain('[REDACTED:known]');
    expect(result.entries[0]!.content).not.toContain('explore-secret-one');
    expect(result.entries[0]!.content).not.toContain('explore-secret-two');
  });

  it('redacts a secret before the find slice, so no part of it is shown', async () => {
    const secret = new Secret('explore-secret-value-42');
    // The secret starts at the two-hundredth character of the line: the slice of a match would cut
    // it in half.
    const reader = fakeReader({
      'src/a.ts': `${'a'.repeat(190)}${secret.reveal()}${'b'.repeat(50)}`,
    });
    const budget = new ExploreBudget(LIMITS);

    await executeRequests([{ read: { path: 'src/a.ts' } }], ctx(reader, budget, {}, [], LIMITS, [secret]));
    const result = await executeRequests(
      [{ find: { text: 'a' } }],
      ctx(reader, budget, {}, [], LIMITS, [secret]),
    );

    expect(result.entries[0]!.content).toContain('src/a.ts:1');
    expect(result.entries[0]!.content).not.toContain('explore-secret');
    expect(result.entries[0]!.content).not.toContain(secret.reveal());
  });
});
