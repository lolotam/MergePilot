import { describe, expect, it } from 'vitest';
import { parsePatch } from '@mergepilot/engine';
import type { PullRequestFile } from './pr-files.js';
import {
  MAX_DIFF_EDIT_LENGTH,
  MAX_REBUILT_PATCH_LINES,
  rebuildMissingPatches,
} from './rebuild-patch.js';
import { fakeClient, OPTS } from './rebuild-patch.fixtures.js';

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

  it('gives up on a diff too costly to compute', async () => {
    // Two contents that differ in more lines than a diff may compute.
    const base = Array.from({ length: MAX_DIFF_EDIT_LENGTH + 1 }, (_, i) => `line ${i}`).join('\n');
    const head = Array.from({ length: MAX_DIFF_EDIT_LENGTH + 1 }, (_, i) => `changed ${i}`).join('\n');
    const { client } = fakeClient({ 'base-sha:src/a.ts': base, 'head-sha:src/a.ts': head });
    const files: PullRequestFile[] = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(result.files[0]!.patch).toBeUndefined();
    expect(result.failed).toEqual([{ path: 'src/a.ts', reason: 'diff too costly to compute' }]);
  }, 120_000);

  it('reads the base content at the merge base, not at the base branch tip', async () => {
    const { client, reads, compares } = fakeClient(
      { 'merge-base:src/a.ts': BASE, 'head-sha:src/a.ts': HEAD },
      {},
      { mergeBaseSha: 'merge-base' },
    );
    const files: PullRequestFile[] = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(compares).toEqual(['base-sha...head-sha']);
    expect(reads).toEqual(['merge-base:src/a.ts', 'head-sha:src/a.ts']);
    expect(result.rebuilt).toEqual(['src/a.ts']);
  });

  it('falls back to the base branch tip when the comparison fails', async () => {
    const { client, reads } = fakeClient(
      { 'base-sha:src/a.ts': BASE, 'head-sha:src/a.ts': HEAD },
      {},
      'fail',
    );
    const files: PullRequestFile[] = [
      { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(reads).toEqual(['base-sha:src/a.ts', 'head-sha:src/a.ts']);
    expect(result.rebuilt).toEqual(['src/a.ts']);
  });

  it('never compares when no candidate reads the base', async () => {
    const { client, compares } = fakeClient(
      { 'head-sha:src/new.ts': 'line 1\n' },
      {},
      { mergeBaseSha: 'merge-base' },
    );
    const files: PullRequestFile[] = [
      { path: 'src/new.ts', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(compares).toEqual([]);
    expect(result.rebuilt).toEqual(['src/new.ts']);
  });

  it('never reads the base of a rename from a sensitive path', async () => {
    const { client, reads } = fakeClient({
      'base-sha:.env': 'SECRET=1\n',
      'head-sha:config.ts': 'export default 1;\n',
    });
    const files: PullRequestFile[] = [
      {
        path: 'config.ts',
        status: 'renamed',
        previousPath: '.env',
        additions: 1,
        deletions: 1,
        changes: 2,
      },
    ];

    const result = await rebuildMissingPatches(client, files, OPTS);

    expect(reads).toEqual([]);
    expect(result.rebuilt).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.files).toEqual(files);
  });

  it('never reads an excluded or a generated path', async () => {
    const { client, reads } = fakeClient({
      'head-sha:docs/notes.md': 'text\n',
      'head-sha:dist/bundle.js': 'code\n',
    });
    const files: PullRequestFile[] = [
      { path: 'docs/notes.md', status: 'added', additions: 1, deletions: 0, changes: 1 },
      { path: 'dist/bundle.js', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const result = await rebuildMissingPatches(client, files, { ...OPTS, exclude: ['docs/**'] });

    expect(reads).toEqual([]);
    expect(result.rebuilt).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
