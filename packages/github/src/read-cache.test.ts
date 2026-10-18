import { describe, expect, it } from 'vitest';
import type { GitHubClient } from './client.js';
import { listAtRef, readAtRef } from './read-cache.js';

describe('readAtRef', () => {
  it('shares one read per client, path and ref', async () => {
    let calls = 0;
    const client = { getFileContent: async () => `v${++calls}` } as unknown as GitHubClient;
    expect(await readAtRef(client, 'o', 'r', 'sha', 'a.ts')).toBe('v1');
    expect(await readAtRef(client, 'o', 'r', 'sha', 'a.ts')).toBe('v1');
    expect(calls).toBe(1);
  });

  it('drops a failed read, so a later caller retries instead of failing again', async () => {
    let calls = 0;
    const client = {
      getFileContent: async () => {
        calls++;
        if (calls === 1) throw new Error('HTTP 502');
        return 'content';
      },
    } as unknown as GitHubClient;
    await expect(readAtRef(client, 'o', 'r', 'sha', 'a.ts')).rejects.toThrow('HTTP 502');
    await expect(readAtRef(client, 'o', 'r', 'sha', 'a.ts')).resolves.toBe('content');
    expect(calls).toBe(2);
  });
});

describe('listAtRef', () => {
  it('shares one listing per client, directory and ref', async () => {
    let calls = 0;
    const client = { listDirectoryFiles: async () => [`f${++calls}.yml`] } as unknown as GitHubClient;
    expect(await listAtRef(client, 'o', 'r', 'sha', '.github/workflows')).toEqual(['f1.yml']);
    expect(await listAtRef(client, 'o', 'r', 'sha', '.github/workflows')).toEqual(['f1.yml']);
    expect(calls).toBe(1);
  });

  it('lists nothing when the client cannot list directories', async () => {
    const client = { getFileContent: async () => null } as unknown as GitHubClient;
    expect(await listAtRef(client, 'o', 'r', 'sha', '.github/workflows')).toBeNull();
  });
});
