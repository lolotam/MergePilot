/**
 * The repository reader of the exploration (ADR-0046): the files of the pull request's own
 * repository, at the PR head, and the paths the rules refuse.
 */

import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { createRepositoryReader } from './explore-reader.js';

const PARAMS = { owner: 'org', repo: 'repo', headSha: 'sha1', exclude: ['**/secret/**'] };

describe('the repository reader of the exploration (ADR-0046)', () => {
  it('reads a file at the PR head', async () => {
    const reads: string[] = [];
    const client = {
      getFileContent: async (params: { path: string; ref: string }) => {
        reads.push(`${params.ref}:${params.path}`);
        return 'const a = 1;';
      },
    } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    expect(await reader.readFile('src/a.ts')).toBe('const a = 1;');
    expect(reads).toEqual(['sha1:src/a.ts']);
  });

  it('reads a file over 100 KB in full, the engine bounds what it shows', async () => {
    const big = 'x'.repeat(200 * 1024);
    const client = { getFileContent: async () => big } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);
    const content = await reader.readFile('src/big.ts');

    // The reader caps nothing: the engine cuts what it shows (maxLinesPerRead, the read budget).
    expect(content).toBe(big);
  });

  it('never reads a refused path', async () => {
    const reads: string[] = [];
    const client = {
      getFileContent: async (params: { path: string }) => {
        reads.push(params.path);
        return 'secret';
      },
    } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    expect(await reader.readFile('../outside.ts')).toBeNull();
    expect(await reader.readFile('.git/config')).toBeNull();
    expect(await reader.readFile('.env')).toBeNull();
    expect(await reader.readFile('src/secret/key.ts')).toBeNull();
    expect(reads).toEqual([]);
  });

  it('lists a directory and keeps the allowed entries only', async () => {
    const listings: string[] = [];
    const client = {
      listDirectoryFiles: async (params: { path: string }) => {
        listings.push(params.path);
        return ['src/a.ts', 'src/secret/key.ts', 'src/.env'];
      },
    } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    expect(await reader.listDirectory('src')).toEqual(['src/a.ts']);
    expect(listings).toEqual(['src']);
  });

  it('lists the tree of the head once and filters the paths', async () => {
    let calls = 0;
    const client = {
      listTreePaths: async () => {
        calls += 1;
        return {
          paths: ['src/a.ts', 'src/secret/key.ts', 'node_modules/x.js'],
          truncated: false,
        };
      },
    } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    expect(await reader.listPaths()).toEqual({ paths: ['src/a.ts'], truncated: false });
    expect(await reader.listPaths()).toEqual({ paths: ['src/a.ts'], truncated: false });
    expect(calls).toBe(1);
  });

  it('says the tree was truncated, so a search over it knows it is partial', async () => {
    const client = {
      listTreePaths: async () => ({ paths: ['src/a.ts'], truncated: true }),
    } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    expect(await reader.listPaths()).toEqual({ paths: ['src/a.ts'], truncated: true });
  });

  it('lists nothing when the client cannot list the tree', async () => {
    const client = { getFileContent: async () => null } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    expect(await reader.listPaths()).toBeNull();
  });

  it('lists the tree again after a failed listing', async () => {
    let calls = 0;
    const client = {
      listTreePaths: async () => {
        calls += 1;
        if (calls === 1) throw new Error('the server is down');
        return { paths: ['src/a.ts'], truncated: false };
      },
    } as unknown as GitHubClient;

    const reader = createRepositoryReader(client, PARAMS);

    await expect(reader.listPaths()).rejects.toThrow('the server is down');
    expect(await reader.listPaths()).toEqual({ paths: ['src/a.ts'], truncated: false });
    expect(calls).toBe(2);
  });
});
