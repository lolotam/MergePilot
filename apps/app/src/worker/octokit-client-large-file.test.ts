import { expect, it, vi } from 'vitest';
import { wrapOctokit, type OctokitLike } from './octokit-client.js';

const params = { owner: 'org', repo: 'project', path: 'openapi.json', ref: 'commit' };
const size = 1_600_000;
const largeFile = { type: 'file', encoding: 'none', sha: 'blob-sha', size };

function clientWith(contents: object, git?: OctokitLike['rest']['git']) {
  return wrapOctokit({ rest: { repos: { getContent: async () => ({ data: contents }) }, git } } as OctokitLike);
}

it('treats empty Contents responses for large files as unread when there is no opt-in', async () => {
  const getBlob = vi.fn();
  const client = clientWith({ ...largeFile, content: '' }, { getBlob });
  expect(await client.getFileContent(params)).toBeNull();
  expect(getBlob).not.toHaveBeenCalled();
});

it('reads a large file by SHA when Contents omits content and the blob fits the limit', async () => {
  const getBlob = vi.fn(async () => ({
    data: { encoding: 'base64', content: Buffer.from('محتوى الملف').toString('base64') },
  }));
  const client = clientWith(largeFile, { getBlob });
  expect(await client.getFileContent({ ...params, maxBytes: size })).toBe('محتوى الملف');
  expect(getBlob).toHaveBeenCalledWith({ owner: params.owner, repo: params.repo, file_sha: 'blob-sha' });
  getBlob.mockClear();
  expect(await client.getFileContent({ ...params, maxBytes: size - 1 })).toBeNull();
  expect(getBlob).not.toHaveBeenCalled();
});

it('can read Contents with a client that has no blobs endpoint', async () => {
  const client = clientWith(largeFile, {});
  expect(await client.getFileContent({ ...params, maxBytes: size })).toBeNull();
});
