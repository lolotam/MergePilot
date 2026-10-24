import { describe, expect, it } from 'vitest';
import { classifyFile, isSensitivePath } from '@mergepilot/engine';
import type { GitHubClient } from './client.js';
import type { PullRequestFile } from './pr-files.js';
import { rebuildMissingPatches } from './rebuild-patch.js';
import { fakeClient, OPTS } from './rebuild-patch.fixtures.js';

const SNAPSHOT_DIR = 'packages/db/migrations/meta';
const PREVIOUS_SNAPSHOT = `${SNAPSHOT_DIR}/0175_snapshot.json`;
const NEW_SNAPSHOT = `${SNAPSHOT_DIR}/0176_snapshot.json`;

/** The patch GitHub sent for a snapshot: the whole new file. */
const WHOLE_FILE_PATCH = '@@ -0,0 +1,2 @@\n+{\n+  "version": "7",';

/** A snapshot's content: only the text matters here, not the shape of the file. */
const PREVIOUS_CONTENT = '{\n  "version": "7"\n}\n';
const NEW_CONTENT = '{\n  "version": "8"\n}\n';

/** The snapshot the pull request adds, with the patch GitHub sent for it. */
function snapshotFile(): PullRequestFile {
  return {
    path: NEW_SNAPSHOT,
    status: 'added',
    additions: 3,
    deletions: 0,
    changes: 3,
    patch: WHOLE_FILE_PATCH,
  };
}

describe('rebuildMissingPatches on a snapshot that cannot be compared (ADR-0045, rule 5)', () => {
  it('drops the whole file when the previous snapshot cannot be read', async () => {
    // The previous snapshot is listed, but the contents API does not return it.
    const { client } = fakeClient(
      { [`head-sha:${NEW_SNAPSHOT}`]: NEW_CONTENT },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );

    const result = await rebuildMissingPatches(client, [snapshotFile()], OPTS);

    expect(result.failed).toEqual([{ path: NEW_SNAPSHOT, reason: 'snapshot diff failed (read)' }]);
    expect(result.rebuilt).toEqual([]);
    expect(result.snapshotDiffs).toEqual([]);
    // The whole snapshot is never sent instead: the patch is dropped, so the review says truncated.
    expect(result.files[0]!.patch).toBeUndefined();
  });

  it('drops the whole file when the previous snapshot is binary', async () => {
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: 'x\0y',
        [`head-sha:${NEW_SNAPSHOT}`]: NEW_CONTENT,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );

    const result = await rebuildMissingPatches(client, [snapshotFile()], OPTS);

    expect(result.failed).toEqual([{ path: NEW_SNAPSHOT, reason: 'snapshot diff failed (read)' }]);
    expect(result.rebuilt).toEqual([]);
    expect(result.files[0]!.patch).toBeUndefined();
  });

  it('drops the whole file when the read of the previous snapshot throws', async () => {
    const client = {
      listDirectoryFiles: async () => ['0175_snapshot.json'],
      getFileContent: async () => {
        throw new Error('contents API is down');
      },
    } as unknown as GitHubClient;

    const result = await rebuildMissingPatches(client, [snapshotFile()], OPTS);

    expect(result.failed).toEqual([{ path: NEW_SNAPSHOT, reason: 'snapshot diff failed (read)' }]);
    expect(result.rebuilt).toEqual([]);
    expect(result.files[0]!.patch).toBeUndefined();
  });

  it('skips a snapshot that did not change, without calling it truncated', async () => {
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: PREVIOUS_CONTENT,
        [`head-sha:${NEW_SNAPSHOT}`]: PREVIOUS_CONTENT,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );

    const result = await rebuildMissingPatches(client, [snapshotFile()], OPTS);

    const file = result.files[0]!;
    expect(file.patch).toBeUndefined();
    expect(file.changes).toBe(0);
    expect(file.additions).toBe(0);
    expect(file.deletions).toBe(0);
    // The engine skips it as a file with no changes: it is never a file with a truncated patch.
    expect(classifyFile(file, { exclude: [], isSensitivePath })).not.toBe('incomplete-truncated');
    // The log still says why the file was left alone.
    expect(result.failed).toEqual([
      { path: NEW_SNAPSHOT, reason: 'no content change from 0175_snapshot.json' },
    ]);
  });

  it('keeps the whole file GitHub sent when there is no previous snapshot', async () => {
    // No folder is listed, so there is no previous snapshot to compare against.
    const { client } = fakeClient({ [`head-sha:${NEW_SNAPSHOT}`]: NEW_CONTENT });

    const result = await rebuildMissingPatches(client, [snapshotFile()], OPTS);

    expect(result.failed).toEqual([]);
    expect(result.snapshotDiffs).toEqual([]);
    // There was no previous snapshot to show only the differences of, so the whole file stands.
    expect(result.files[0]!.patch).toBe(WHOLE_FILE_PATCH);
  });
});
