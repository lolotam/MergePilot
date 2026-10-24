import { describe, expect, it } from 'vitest';
import { parsePatch } from '@mergepilot/engine';
import type { GitHubClient, GetFileContentParams } from './client.js';
import type { PullRequestFile } from './pr-files.js';
import { MAX_REBUILT_PATCH_LINES, rebuildMissingPatches } from './rebuild-patch.js';

const OPTS = { owner: 'o', repo: 'r', baseSha: 'base-sha', headSha: 'head-sha' };

/** A client whose contents API answers from a map of `ref:path` to content. */
function fakeClient(
  contents: Record<string, string>,
  listings: Record<string, string[]> = {},
): { client: GitHubClient; reads: string[]; lists: string[] } {
  const reads: string[] = [];
  const lists: string[] = [];
  const client = {
    async getFileContent({ path, ref }: GetFileContentParams) {
      reads.push(`${ref}:${path}`);
      return contents[`${ref}:${path}`] ?? null;
    },
    async listDirectoryFiles({ path, ref }: GetFileContentParams) {
      lists.push(`${ref}:${path}`);
      return listings[`${ref}:${path}`] ?? null;
    },
  } as unknown as GitHubClient;
  return { client, reads, lists };
}

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\n';
const HEAD = 'a\nb\nc\nd\ne\nf\nX\nh\n';

describe('rebuildMissingPatches (ADR-0045)', () => {
  it('rebuilds an added file as one hunk of added lines', async () => {
    const { client } = fakeClient({ 'head-sha:src/new.ts': 'line 1\nline 2\n' });
    const files: PullRequestFile[] = [
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.rebuilt).toEqual(['src/new.ts']);
    expect(result.failed).toEqual([]);
    expect(result.files[0]!.patch).toBe('@@ -0,0 +1,2 @@\n+line 1\n+line 2');
    const parsed = parsePatch(result.files[0]!.patch!);
    expect([...parsed.addedLines]).toEqual([1, 2]);
  });

  it('marks a file whose content has no trailing newline', async () => {
    const { client } = fakeClient({ 'head-sha:src/new.ts': 'line 1' });
    const files: PullRequestFile[] = [
      { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBe('@@ -0,0 +1,1 @@\n+line 1\n\\ No newline at end of file');
  });

  it('rebuilds a modified file as hunks with the right headers', async () => {
    const { client } = fakeClient({ 'base-sha:src/a.ts': BASE, 'head-sha:src/a.ts': HEAD });
    const files: PullRequestFile[] = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    const patch = result.files[0]!.patch!;
    expect(patch).toContain('-g');
    expect(patch).toContain('+X');
    const parsed = parsePatch(patch);
    // Three lines of context around the change.
    expect(parsed.hunks).toEqual([{ oldStart: 4, oldLines: 5, newStart: 4, newLines: 5 }]);
    expect([...parsed.rightLines].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8]);
    expect([...parsed.leftLines].sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8]);
    expect(parsed.addedLines.has(7)).toBe(true);
  });

  it('reads the base of a rename at the path it had before', async () => {
    const { client, reads } = fakeClient({ 'base-sha:src/old.ts': BASE, 'head-sha:src/new.ts': HEAD });
    const files: PullRequestFile[] = [
      {
        path: 'src/new.ts',
        status: 'renamed',
        previousPath: 'src/old.ts',
        additions: 1,
        deletions: 1,
        changes: 2,
      },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(reads).toEqual(['base-sha:src/old.ts', 'head-sha:src/new.ts']);
    expect(result.rebuilt).toEqual(['src/new.ts']);
    expect(result.files[0]!.previousPath).toBe('src/old.ts');
    expect(result.files[0]!.patch).toContain('+X');
  });

  it('leaves a file the contents API does not return unchanged, and says why', async () => {
    const { client } = fakeClient({});
    const files: PullRequestFile[] = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.rebuilt).toEqual([]);
    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.failed).toEqual([{ path: 'src/a.ts', reason: 'not returned by the contents API' }]);
  });

  it('refuses a binary file', async () => {
    const { client } = fakeClient({ 'head-sha:src/a.png': 'x\0y' });
    const files: PullRequestFile[] = [
      { path: 'src/a.png', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.failed).toEqual([{ path: 'src/a.png', reason: 'binary' }]);
  });

  it('refuses a patch over the line limit', async () => {
    const many = Array.from({ length: MAX_REBUILT_PATCH_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
    const { client } = fakeClient({ 'head-sha:src/big.txt': `${many}\n` });
    const files: PullRequestFile[] = [
      { path: 'src/big.txt', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.failed).toEqual([{ path: 'src/big.txt', reason: 'over 50,000 diff lines' }]);
  });

  it('never fails the review when a read throws', async () => {
    const client = {
      getFileContent: async () => {
        throw new Error('contents API is down');
      },
    } as unknown as GitHubClient;
    const files: PullRequestFile[] = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.failed).toEqual([{ path: 'src/a.ts', reason: 'not returned by the contents API' }]);
  });

  it('leaves a patched file, a removed file and a sensitive path alone, and reads nothing', async () => {
    const { client, reads } = fakeClient({ 'head-sha:.env': 'SECRET=1\n' });
    const files: PullRequestFile[] = [
      {
        path: 'src/ok.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: '@@ -1,1 +1,1 @@\n-a\n+b',
      },
      { path: 'src/gone.ts', status: 'removed', additions: 0, deletions: 3, changes: 3 },
      { path: '.env', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(reads).toEqual([]);
    expect(result.rebuilt).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.files).toEqual(files);
  });

  it('reads at most four files at a time', async () => {
    let running = 0;
    let peak = 0;
    const client = {
      getFileContent: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running--;
        return null;
      },
    } as unknown as GitHubClient;
    const files: PullRequestFile[] = Array.from({ length: 9 }, (_, i) => ({
      path: `src/f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 1,
      changes: 2,
    }));

    await rebuildMissingPatches(client, files, OPTS);

    expect(peak).toBeLessThanOrEqual(4);
  });
});

const SNAPSHOT_DIR = 'packages/db/migrations/meta';
const PREVIOUS_SNAPSHOT = `${SNAPSHOT_DIR}/0175_snapshot.json`;
const NEW_SNAPSHOT = `${SNAPSHOT_DIR}/0176_snapshot.json`;

/** A snapshot of nine lines, with a "name" column of type text. */
const SNAPSHOT_TEXT = [
  '{',
  '  "version": "7",',
  '  "tables": {',
  '    "users": {',
  '      "id": { "type": "integer" },',
  '      "name": { "type": "text" }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

/** The same snapshot, with the "name" column of type varchar. */
const SNAPSHOT_VARCHAR = [
  '{',
  '  "version": "7",',
  '  "tables": {',
  '    "users": {',
  '      "id": { "type": "integer" },',
  '      "name": { "type": "varchar" }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

/** The same snapshot, with a "legacy" column the other one dropped. */
const SNAPSHOT_WITH_LEGACY = [
  '{',
  '  "version": "7",',
  '  "tables": {',
  '    "users": {',
  '      "id": { "type": "integer" },',
  '      "legacy": { "type": "text" },',
  '      "name": { "type": "text" }',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

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
    expect(lists).toEqual([`base-sha:${SNAPSHOT_DIR}`]);

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
});
