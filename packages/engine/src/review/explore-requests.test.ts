/**
 * The requests of an exploration round (ADR-0046): the paths the rules refuse, the reads that
 * are cut to the budget, the searches and the listings.
 */

import { describe, expect, it } from 'vitest';
import type { ExploreLimits } from '../config/schema.js';
import { isContextPathAllowed } from '../diff/classify-file.js';
import { isSensitivePath } from '../security/sensitive-path.js';
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
  paths: string[] | null = null,
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
      return paths;
    },
  };
  return reader;
}

function ctx(
  reader: RepositoryReader,
  budget: ExploreBudget,
  heldTexts: Map<string, string> = new Map(),
  limits: ExploreLimits = LIMITS,
): Parameters<typeof executeRequests>[1] {
  return { reader, budget, limits, allowPath, heldTexts };
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

    const result = await executeRequests([{ read: { path: 'src/a.ts' } }], ctx(reader, budget, new Map(), { ...LIMITS, maxLinesPerRead: 20 }));

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
    const held = new Map([['src/held.ts', 'const found = 0;']]);

    await executeRequests([{ read: { path: 'src/read.ts' } }], ctx(reader, budget, held));
    const result = await executeRequests([{ find: { text: 'found' } }], ctx(reader, budget, held));

    expect(result.entries[0]!.content).toContain('src/held.ts:1: const found = 0;');
    expect(result.entries[0]!.content).toContain('src/read.ts:1: const found = 1;');
  });

  it('limits a search to the paths that start with the given prefix', async () => {
    const reader = fakeReader();
    const budget = new ExploreBudget(LIMITS);
    const held = new Map([
      ['src/a.ts', 'const found = 1;'],
      ['lib/b.ts', 'const found = 2;'],
    ]);

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
    const held = new Map(
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

  it('answers a failed path listing with "read failed" and goes on with the next request', async () => {
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

    const result = await executeRequests(
      [{ find: { text: 'guard' } }, { read: { path: 'src/a.ts' } }],
      ctx(reader, budget),
    );

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.content).toBe('read failed');
    expect(result.entries[0]!.content).not.toContain('the server is down');
    expect(result.entries[1]!.content).toBe('not found');
  });
});
