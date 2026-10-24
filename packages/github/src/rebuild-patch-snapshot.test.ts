import { describe, expect, it } from 'vitest';
import { parsePatch } from '@mergepilot/engine';
import type { PullRequestFile } from './pr-files.js';
import {
  MAX_DIFF_EDIT_LENGTH,
  MAX_REBUILT_PATCH_LINES,
  rebuildMissingPatches,
} from './rebuild-patch.js';
import { fakeClient, OPTS } from './rebuild-patch.fixtures.js';

const SNAPSHOT_DIR = 'packages/db/migrations/meta';
const PREVIOUS_SNAPSHOT = `${SNAPSHOT_DIR}/0175_snapshot.json`;
const NEW_SNAPSHOT = `${SNAPSHOT_DIR}/0176_snapshot.json`;

/** A drizzle snapshot with the given columns under "users". */
function snapshot(columns: string[]): string {
  return [
    '{',
    '  "version": "7",',
    '  "tables": {',
    '    "users": {',
    ...columns.map((column, index) => `      ${column}${index === columns.length - 1 ? '' : ','}`),
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
}

const ID_COLUMN = '"id": { "type": "integer" }';
const NAME_TEXT = '"name": { "type": "text" }';
const NAME_VARCHAR = '"name": { "type": "varchar" }';
const LEGACY_COLUMN = '"legacy": { "type": "text" }';

/** The patch GitHub sent for a snapshot: the whole new file. */
const WHOLE_FILE_PATCH = '@@ -0,0 +1,2 @@\n+{\n+  "version": "7",';

/**
 * A snapshot with `changes` changed lines, each far enough from the next to be a hunk of its own:
 * nine unchanged lines between them, more than the three lines of context on each side.
 */
function wideSnapshot(changes: number, tag: string): string {
  const lines: string[] = [];
  for (let i = 0; i < changes; i++) {
    for (let j = 0; j < 9; j++) lines.push(`same ${i} ${j}`);
    lines.push(`${tag} ${i}`);
  }
  return lines.join('\n');
}

/** A snapshot of nine lines, with a "name" column of type text. */
const SNAPSHOT_TEXT = snapshot([ID_COLUMN, NAME_TEXT]);
/** The same snapshot, with the "name" column of type varchar. */
const SNAPSHOT_VARCHAR = snapshot([ID_COLUMN, NAME_VARCHAR]);
/** The same snapshot, with a "legacy" column the other one dropped. */
const SNAPSHOT_WITH_LEGACY = snapshot([ID_COLUMN, LEGACY_COLUMN, NAME_TEXT]);

describe('rebuildMissingPatches on a migration snapshot (ADR-0045, rule 5)', () => {
  it('reviews a snapshot only where it differs from the previous snapshot', async () => {
    const { client, reads, lists } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: SNAPSHOT_TEXT,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_VARCHAR,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0174_snapshot.json', '0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      { path: NEW_SNAPSHOT, status: 'added', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.rebuilt).toEqual([NEW_SNAPSHOT]);
    expect(result.failed).toEqual([]);
    expect(result.snapshotDiffs).toEqual([{ path: NEW_SNAPSHOT, previous: '0175_snapshot.json' }]);
    // The previous snapshot is read at the base commit, and only the newest one below it.
    expect(reads).toContain(`base-sha:${PREVIOUS_SNAPSHOT}`);
    expect(reads).not.toContain(`base-sha:${SNAPSHOT_DIR}/0174_snapshot.json`);
    // Both listings are read: the head's and the merge base's.
    expect(lists).toEqual([`base-sha:${SNAPSHOT_DIR}`, `head-sha:${SNAPSHOT_DIR}`]);

    const patch = result.files[0]!.patch!;
    const [header, ...body] = patch.split('\n');
    // The first header names the snapshot the diff is against.
    expect(header).toBe(
      '@@ -0,0 +3,7 @@ compared with 0175_snapshot.json: only the regions that differ are shown',
    );
    // Every line is an added line of the new file.
    expect(body.every((line) => line.startsWith('+'))).toBe(true);
    expect(body).toContain('+      "name": { "type": "varchar" }');

    // The line numbers are the new file's own.
    const parsed = parsePatch(patch);
    expect(parsed.hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 3, newLines: 7 }]);
    const newLines = SNAPSHOT_VARCHAR.split('\n');
    const added = [...parsed.addedLines].sort((a, b) => a - b);
    expect(added.map((line) => newLines[line - 1])).toEqual([
      '  "tables": {',
      '    "users": {',
      '      "id": { "type": "integer" },',
      '      "name": { "type": "varchar" }',
      '    }',
      '  }',
      '}',
    ]);
  });

  it('does not show a line the previous snapshot had and the new one dropped', async () => {
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: SNAPSHOT_WITH_LEGACY,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_TEXT,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      { path: NEW_SNAPSHOT, status: 'added', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    const patch = result.files[0]!.patch!;
    expect(patch).not.toContain('legacy');
    expect(patch).toContain('+      "name": { "type": "text" }');
    expect(patch.split('\n').slice(1).every((line) => line.startsWith('+'))).toBe(true);
    // The kept lines are the new file's own lines.
    const parsed = parsePatch(patch);
    expect([...parsed.rightLines].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('takes the previous snapshot from the head when the base has none', async () => {
    const { client, reads, lists } = fakeClient(
      {
        [`head-sha:${PREVIOUS_SNAPSHOT}`]: SNAPSHOT_TEXT,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_VARCHAR,
      },
      {
        [`base-sha:${SNAPSHOT_DIR}`]: [],
        [`head-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json', '0176_snapshot.json'],
      },
    );
    const files: PullRequestFile[] = [
      { path: NEW_SNAPSHOT, status: 'added', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.snapshotDiffs).toEqual([{ path: NEW_SNAPSHOT, previous: '0175_snapshot.json' }]);
    // Read at the commit whose listing found it.
    expect(reads).toContain(`head-sha:${PREVIOUS_SNAPSHOT}`);
    expect(lists).toEqual([`base-sha:${SNAPSHOT_DIR}`, `head-sha:${SNAPSHOT_DIR}`]);
    expect(result.files[0]!.patch).toContain('compared with 0175_snapshot.json');
  });

  it('diffs a snapshot against the snapshot the pull request adds itself', async () => {
    const { client, reads } = fakeClient(
      {
        [`base-sha:${SNAPSHOT_DIR}/0174_snapshot.json`]: SNAPSHOT_TEXT,
        [`head-sha:${SNAPSHOT_DIR}/0175_snapshot.json`]: SNAPSHOT_TEXT,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_VARCHAR,
      },
      {
        [`base-sha:${SNAPSHOT_DIR}`]: ['0174_snapshot.json'],
        [`head-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json', '0176_snapshot.json'],
      },
    );
    const files: PullRequestFile[] = [
      { path: `${SNAPSHOT_DIR}/0175_snapshot.json`, status: 'added', additions: 9, deletions: 0, changes: 9 },
      { path: NEW_SNAPSHOT, status: 'added', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    // The newer snapshot follows the one the pull request adds itself, read at the head commit.
    expect(result.snapshotDiffs).toEqual([{ path: NEW_SNAPSHOT, previous: '0175_snapshot.json' }]);
    expect(reads).toContain(`head-sha:${SNAPSHOT_DIR}/0175_snapshot.json`);
    expect(result.files[1]!.patch).toContain('compared with 0175_snapshot.json');
    // The older snapshot still follows the last one of the base branch.
    expect(reads).toContain(`base-sha:${SNAPSHOT_DIR}/0174_snapshot.json`);
  });

  it('falls back to the whole new file when there is no previous snapshot', async () => {
    const { client } = fakeClient({ [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_VARCHAR });
    const files: PullRequestFile[] = [
      { path: NEW_SNAPSHOT, status: 'added', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.snapshotDiffs).toEqual([]);
    expect(result.rebuilt).toEqual([NEW_SNAPSHOT]);
    expect(result.files[0]!.patch).toBe(
      [
        '@@ -0,0 +1,9 @@',
        '+{',
        '+  "version": "7",',
        '+  "tables": {',
        '+    "users": {',
        '+      "id": { "type": "integer" },',
        '+      "name": { "type": "varchar" }',
        '+    }',
        '+  }',
        '+}',
      ].join('\n'),
    );
  });

  it('replaces the patch GitHub sent for the snapshot with the diff', async () => {
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: SNAPSHOT_TEXT,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_VARCHAR,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      {
        path: NEW_SNAPSHOT,
        status: 'added',
        additions: 9,
        deletions: 0,
        changes: 9,
        patch: '@@ -0,0 +1,9 @@\n+{\n+  "version": "7",\n+  "tables": {',
      },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.rebuilt).toEqual([NEW_SNAPSHOT]);
    expect(result.snapshotDiffs).toEqual([{ path: NEW_SNAPSHOT, previous: '0175_snapshot.json' }]);
    expect(result.files[0]!.patch).toContain('compared with 0175_snapshot.json');
    expect(result.files[0]!.patch).not.toContain('@@ -0,0 +1,9 @@');
  });

  it('drops the whole-file patch GitHub sent for a snapshot that did not change', async () => {
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: SNAPSHOT_TEXT,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_TEXT,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      { path: NEW_SNAPSHOT, status: 'added', patch: '@@ -0,0 +1,1 @@\n+{}', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.failed).toEqual([
      { path: NEW_SNAPSHOT, reason: 'no content change from 0175_snapshot.json' },
    ]);
  });

  it('leaves a snapshot that did not change alone, and says why', async () => {
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: SNAPSHOT_TEXT,
        [`head-sha:${NEW_SNAPSHOT}`]: SNAPSHOT_TEXT,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      { path: NEW_SNAPSHOT, status: 'added', additions: 9, deletions: 0, changes: 9 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.rebuilt).toEqual([]);
    expect(result.snapshotDiffs).toEqual([]);
    expect(result.failed).toEqual([
      { path: NEW_SNAPSHOT, reason: 'no content change from 0175_snapshot.json' },
    ]);
  });

  it('leaves an added JSON file that is not a snapshot alone', async () => {
    const { client, lists } = fakeClient({ 'head-sha:packages/db/seed.json': '{"a": 1}\n' });
    const files: PullRequestFile[] = [
      { path: 'packages/db/seed.json', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    // No folder is listed for a file that is not a snapshot.
    expect(lists).toEqual([]);
    expect(result.snapshotDiffs).toEqual([]);
    expect(result.rebuilt).toEqual(['packages/db/seed.json']);
    expect(result.files[0]!.patch).toBe('@@ -0,0 +1,1 @@\n+{"a": 1}');
  });

  it('gives up on a snapshot diff that is too costly, and drops the file patch', async () => {
    // Two snapshots that differ in more lines than a diff may compute.
    const base = Array.from({ length: MAX_DIFF_EDIT_LENGTH + 1 }, (_, i) => `line ${i}`).join('\n');
    const head = Array.from({ length: MAX_DIFF_EDIT_LENGTH + 1 }, (_, i) => `changed ${i}`).join('\n');
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: base,
        [`head-sha:${NEW_SNAPSHOT}`]: head,
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      {
        path: NEW_SNAPSHOT,
        status: 'added',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: WHOLE_FILE_PATCH,
      },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.failed).toEqual([{ path: NEW_SNAPSHOT, reason: 'snapshot diff failed (costly)' }]);
    expect(result.rebuilt).toEqual([]);
    expect(result.snapshotDiffs).toEqual([]);
    // The whole snapshot is never sent instead: the patch is dropped, so the review says truncated.
    expect(result.files[0]!.patch).toBeUndefined();
  }, 120_000);

  it('gives up on a huge snapshot diff, and drops the file patch', async () => {
    // A hunk of one changed line is eight patch lines: its header, three lines of context, the
    // line itself and three more lines of context. That many hunks is over the line limit, and a
    // diff of so many changes needs more edits than it may compute: it gives up before the patch
    // is ever built, so the reason is the costly one and never the large one.
    const hunks = Math.ceil(MAX_REBUILT_PATCH_LINES / 8) + 50;
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: wideSnapshot(hunks, 'old'),
        [`head-sha:${NEW_SNAPSHOT}`]: wideSnapshot(hunks, 'new'),
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      {
        path: NEW_SNAPSHOT,
        status: 'added',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: WHOLE_FILE_PATCH,
      },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.failed).toEqual([{ path: NEW_SNAPSHOT, reason: 'snapshot diff failed (costly)' }]);
    expect(result.rebuilt).toEqual([]);
    expect(result.snapshotDiffs).toEqual([]);
    // The whole snapshot is never sent instead: the patch is dropped, so the review says truncated.
    expect(result.files[0]!.patch).toBeUndefined();
  }, 120_000);

  it('gives up on a snapshot diff with nothing left to show, and drops the file patch', async () => {
    // The new snapshot is empty: the diff holds only removed lines, so no region differs.
    const { client } = fakeClient(
      {
        [`base-sha:${PREVIOUS_SNAPSHOT}`]: 'line 1\nline 2\nline 3\n',
        [`head-sha:${NEW_SNAPSHOT}`]: '',
      },
      { [`base-sha:${SNAPSHOT_DIR}`]: ['0175_snapshot.json'] },
    );
    const files: PullRequestFile[] = [
      {
        path: NEW_SNAPSHOT,
        status: 'added',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: WHOLE_FILE_PATCH,
      },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.failed).toEqual([{ path: NEW_SNAPSHOT, reason: 'snapshot diff failed (empty)' }]);
    expect(result.rebuilt).toEqual([]);
    expect(result.files[0]!.patch).toBeUndefined();
  });
});
