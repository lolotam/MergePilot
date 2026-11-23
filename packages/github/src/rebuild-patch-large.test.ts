import { parsePatch } from '@mergepilot/engine';
import { expect, it } from 'vitest';
import type { GetFileContentParams, GitHubClient } from './client.js';
import { MAX_REBUILD_FILE_BYTES, rebuildMissingPatches } from './rebuild-patch.js';
import { OPTS } from './rebuild-patch.fixtures.js';

const path = 'api/openapi.json';
const file = { path, status: 'modified', additions: 1, deletions: 1, changes: 2 };

function rebuild(includeHead: boolean) {
  const prefix = Array.from({ length: 15 }, (_, i) => `line ${i + 1}\n`).join('');
  const client = {
    async getFileContent({ ref, maxBytes }: GetFileContentParams) {
      if (maxBytes !== MAX_REBUILD_FILE_BYTES) return null;
      if (ref === OPTS.baseSha) return prefix + '"version": "old"\n';
      return includeHead ? prefix + '"version": "new"\n' : null;
    },
  } as GitHubClient;
  return rebuildMissingPatches(client, [file], OPTS);
}

it('rebuilds an omitted patch using large reads and keeps true old and new line numbers', async () => {
  const result = await rebuild(true);
  expect(result.rebuilt).toEqual([path]);
  expect(result.failed).toEqual([]);
  const patch = result.files[0]!.patch!;
  expect(patch).toContain('-"version": "old"\n+"version": "new"');
  expect(parsePatch(patch).hunks).toEqual([{ oldStart: 13, oldLines: 4, newStart: 13, newLines: 4 }]);
});

it('keeps the original file patchless when the blob is unavailable', async () => {
  const result = await rebuild(false);
  expect(result.files).toEqual([file]);
  expect(result.rebuilt).toEqual([]);
  expect(result.failed).toEqual([{ path, reason: 'not returned by the contents API' }]);
});
