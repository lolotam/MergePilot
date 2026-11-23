import { beforeEach, expect, it, vi } from 'vitest';
import { createOctokitClient } from './client.js';
import { MAX_LARGE_READ_CACHE_CHARS, readAtRef } from './read-cache.js';

const { getBlob, getContent } = vi.hoisted(() => ({ getBlob: vi.fn(), getContent: vi.fn() }));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    rest = { repos: { getContent }, git: { getBlob } };
  },
}));

const token = 'test-private-token';
const params = { owner: 'org', repo: 'project', path: 'openapi.json', ref: 'commit' };
const size = 1_600_000;
const largeFile = { type: 'file', encoding: 'none', sha: 'blob-sha', size };

beforeEach(() => {
  getContent.mockReset().mockResolvedValue({ data: largeFile });
  getBlob.mockReset().mockResolvedValue({
    data: { encoding: 'base64', content: Buffer.from('{"name":"دليل"}').toString('base64') },
  });
});

it('does not request a blob without explicit opt-in', async () => {
  getContent.mockResolvedValueOnce({ data: { ...largeFile, content: '' } });
  expect(await createOctokitClient(token).getFileContent(params)).toBeNull();
  expect(getBlob).not.toHaveBeenCalled();
});

it('reads the blob by SHA at the size limit even when Contents omits the content property', async () => {
  expect(await createOctokitClient(token).getFileContent({ ...params, maxBytes: size })).toBe('{"name":"دليل"}');
  expect(getBlob).toHaveBeenCalledWith({ owner: params.owner, repo: params.repo, file_sha: 'blob-sha' });
});

it('leaves oversized files unread and rejects incorrectly encoded blobs', async () => {
  const client = createOctokitClient(token);
  expect(await client.getFileContent({ ...params, maxBytes: size - 1 })).toBeNull();
  expect(getBlob).not.toHaveBeenCalled();
  getBlob.mockResolvedValueOnce({ data: { encoding: 'utf-8', content: 'unexpected' } });
  expect(await client.getFileContent({ ...params, maxBytes: size })).toBeNull();
});

it('treats a missing blob as absent and redacts credentials from other blob errors', async () => {
  const client = createOctokitClient(token);
  getBlob.mockRejectedValueOnce({ status: 404 });
  expect(await client.getFileContent({ ...params, maxBytes: size })).toBeNull();
  getBlob.mockRejectedValueOnce(new Error(`Blob request failed for ${token}`));
  await expect(client.getFileContent({ ...params, maxBytes: size })).rejects
    .toThrow(/^Blob request failed for \[REDACTED\]$/);
});

it('caches normal reads and each byte limit separately', async () => {
  const client = createOctokitClient(token);
  const read = (limit?: number) => readAtRef(client, params.owner, params.repo, params.ref, params.path, limit);
  const getFileContent = vi.spyOn(client, 'getFileContent');
  expect(await read()).toBeNull();
  expect(await read(size - 1)).toBeNull();
  expect(await read(size)).toBe('{"name":"دليل"}');
  expect(await read(size)).toBe('{"name":"دليل"}');
  expect(await read()).toBeNull();
  expect(getFileContent.mock.calls).toEqual([[params], [{ ...params, maxBytes: size - 1 }], [{ ...params, maxBytes: size }]]);
  expect(getBlob).toHaveBeenCalledTimes(1);
});

it('evicts oldest settled large reads once the per-client character cap is exceeded', async () => {
  const chunk = 'x'.repeat(Math.floor(MAX_LARGE_READ_CACHE_CHARS / 2) + 1);
  const getFileContent = vi.fn(async ({ path }: { path: string }) => `${path}:${chunk}`);
  const client = { getFileContent } as unknown as ReturnType<typeof createOctokitClient>;
  const read = (path: string) => readAtRef(client, params.owner, params.repo, params.ref, path, size);

  expect(await read('a.json')).toBe(`a.json:${chunk}`);
  // Still within the cap: repeated read hits the cache.
  expect(await read('a.json')).toBe(`a.json:${chunk}`);
  expect(getFileContent).toHaveBeenCalledTimes(1);

  // Adding a second entry pushes total chars past MAX_LARGE_READ_CACHE_CHARS and evicts a.json.
  expect(await read('b.json')).toBe(`b.json:${chunk}`);
  expect(await read('b.json')).toBe(`b.json:${chunk}`);
  expect(getFileContent).toHaveBeenCalledTimes(2);

  // Reading a.json again refetches because it was evicted.
  expect(await read('a.json')).toBe(`a.json:${chunk}`);
  expect(getFileContent).toHaveBeenCalledTimes(3);
});
