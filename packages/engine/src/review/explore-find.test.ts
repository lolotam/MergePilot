/**
 * The matches of one search (ADR-0046): the line numbers of a file at the head, and the ones a
 * patch takes from its hunk headers. The search answers with them, so a match in a patch points at
 * the head and not at the diff.
 */

import { describe, expect, it } from 'vitest';
import type { ExploreLimits } from '../config/schema.js';
import { isContextPathAllowed } from '../diff/classify-file.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { ExploreBudget, heldTextsOf, type RepositoryReader } from './explore.js';
import { matchPlace, matchesInFile, matchesInPatch } from './explore-find.js';
import { executeRequests } from './explore-requests.js';

const LIMITS: ExploreLimits = {
  maxRounds: 3,
  maxRequestsPerRound: 8,
  maxReadTokens: 30_000,
  maxLinesPerRead: 400,
};

const allowPath = (path: string): boolean =>
  isContextPathAllowed(path, { exclude: [], isSensitivePath });

const PATCH = ['@@ -1,3 +500,3 @@', '+const a = 1;', '+const b = 2;', '+const c = 3;', '-const old = 4;'].join('\n');

function fakeReader(paths: string[] | null = null, truncated = false): RepositoryReader {
  return {
    async readFile() {
      return null;
    },
    async listDirectory() {
      return null;
    },
    async listPaths() {
      return paths === null ? null : { paths, truncated };
    },
  };
}

/** The search of `text` over the held files, with the paths of the head. */
async function find(
  text: string,
  held: Record<string, string>,
  patches: readonly string[] = [],
  reader: RepositoryReader = fakeReader(),
): Promise<string> {
  const result = await executeRequests(
    [{ find: { text } }],
    {
      reader,
      budget: new ExploreBudget(LIMITS),
      limits: LIMITS,
      allowPath,
      heldTexts: { texts: new Map(Object.entries(held)), patches: new Set(patches) },
      knownSecrets: [],
    },
  );
  return result.entries[0]!.content;
}

/** The search of `text` over the files a review holds: its patches and its context files. */
async function findHeld(
  text: string,
  files: readonly { path: string; patch: string }[],
  contextFiles: readonly { path: string; content: string; source?: 'pull-request' | undefined }[],
): Promise<string> {
  const result = await executeRequests(
    [{ find: { text } }],
    {
      reader: fakeReader(),
      budget: new ExploreBudget(LIMITS),
      limits: LIMITS,
      allowPath,
      heldTexts: heldTextsOf(files, contextFiles),
      knownSecrets: [],
    },
  );
  return result.entries[0]!.content;
}

describe('the matches of one search (ADR-0046)', () => {
  it('gives the line numbers of a file at the head', () => {
    const matches = matchesInFile('const a = 1;\nconst b = 2;', 'const b', 10);

    expect(matches).toEqual([{ line: 2, text: 'const b = 2;' }]);
    expect(matchPlace('src/a.ts', matches[0]!)).toBe('src/a.ts:2');
  });

  it('takes the line numbers of a patch from its hunk headers', () => {
    const matches = matchesInPatch(PATCH, 'const c', 10);

    expect(matches).toEqual([{ line: 502, text: 'const c = 3;' }]);
    expect(matchPlace('src/a.ts', matches[0]!)).toBe('src/a.ts:502');
  });

  it('gives a removed line of a patch no line number', () => {
    const matches = matchesInPatch(PATCH, 'const old', 10);

    expect(matches).toEqual([{ line: undefined, text: 'const old = 4;' }]);
    expect(matchPlace('src/a.ts', matches[0]!)).toBe('src/a.ts (removed line)');
  });

  it('never matches the header of a patch', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      ' const a = 1;',
    ].join('\n');

    expect(matchesInPatch(patch, 'src/a.ts', 10)).toEqual([]);
  });

  it('stops at the limit of the matches', () => {
    const file = ['const found = 1;', 'const found = 2;', 'const found = 3;'].join('\n');

    expect(matchesInFile(file, 'found', 2)).toHaveLength(2);
  });

  it('shows the head line of a match in a patch, and no line for a removed one', async () => {
    const added = await find('const c', { 'src/a.ts': PATCH }, ['src/a.ts']);
    const removed = await find('const old', { 'src/a.ts': PATCH }, ['src/a.ts']);

    expect(added).toContain('src/a.ts:502: const c = 3;');
    expect(removed).toContain('src/a.ts (removed line): const old = 4;');
  });

  it('shows the line of a match in a context file, not the diff\'s', async () => {
    const content = await find('const found', { 'src/a.ts': 'const found = 1;' });

    expect(content).toContain('src/a.ts:1: const found = 1;');
  });

  it('says the path list is partial when the tree was truncated', async () => {
    const content = await find('guard', {}, [], fakeReader(['src/guard.ts'], true));

    expect(content).toContain('src/guard.ts');
    expect(content.trimEnd().endsWith('(the repository path list is partial: GitHub truncated the tree)')).toBe(true);
  });

  it('takes the line of a match in a PR_CONTEXT file from its hunk header', async () => {
    const patch = ['@@ -1,1 +40,2 @@', ' const a = 1;', '+const found = 2;'].join('\n');

    const content = await findHeld('const found', [], [
      { path: 'src/pr.ts', content: patch, source: 'pull-request' },
    ]);

    // The PR_CONTEXT file holds the pull request's patch of the file, so the line is the head's.
    expect(content).toContain('src/pr.ts:41: const found = 2;');
  });

  it('keeps a repository context file the file at the head', async () => {
    const content = await findHeld('const found', [], [
      { path: 'src/a.ts', content: 'const found = 1;' },
    ]);

    expect(content).toContain('src/a.ts:1: const found = 1;');
  });
});
