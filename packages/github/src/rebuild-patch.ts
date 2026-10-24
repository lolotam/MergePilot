/**
 * Rebuilding the patch GitHub left out (ADR-0045): the pull request files API omits the patch of
 * a file whose diff is too big, so the bots would see nothing of it. The patch is rebuilt from the
 * file contents at the pull request's base and head commits, and used like any GitHub patch.
 * A drizzle migration snapshot is a whole copy of the schema, so it is reviewed only where it
 * differs from the previous snapshot of the same folder (ADR-0045, rule 5).
 */
import { isSensitivePath } from '@mergepilot/engine';
import { structuredPatch } from 'diff';
import type { GitHubClient } from './client.js';
import type { PullRequestFile } from './pr-files.js';
import { listAtRef, readAtRef } from './read-cache.js';

/** The most diff lines a rebuilt patch may have; a bigger one is not used (ADR-0045). */
export const MAX_REBUILT_PATCH_LINES = 50_000;

/** How many contents reads run at the same time. */
const MAX_CONCURRENT_READS = 4;

/** The statuses whose patch can be rebuilt from the file contents. */
const REBUILDABLE_STATUSES = new Set(['added', 'modified', 'renamed', 'copied']);

/** A drizzle migration snapshot: `packages/db/migrations/meta/0175_snapshot.json`. */
const SNAPSHOT_PATH_RE = /(^|\/)migrations\/meta\/(\d+)_snapshot\.json$/;

/** A snapshot file name: `0175_snapshot.json`. */
const SNAPSHOT_NAME_RE = /^(\d+)_snapshot\.json$/;

/** Why a patch could not be rebuilt; the file keeps the patch GitHub gave it (none). */
const NOT_RETURNED = 'not returned by the contents API';
const BINARY = 'binary';
const TOO_LARGE = `over ${MAX_REBUILT_PATCH_LINES.toLocaleString('en-US')} diff lines`;
const NO_CHANGE = 'no content change';

export interface RebuildPatchesOptions {
  owner: string;
  repo: string;
  /** The pull request's base commit: where the old content is read. */
  baseSha: string;
  /** The pull request's head commit: where the new content is read. */
  headSha: string;
}

export interface RebuildPatchesResult {
  /** The files, with the rebuilt patches in place of the missing ones. */
  files: PullRequestFile[];
  /** The paths whose patch was rebuilt. */
  rebuilt: string[];
  /** The paths whose patch could not be rebuilt, and why. */
  failed: Array<{ path: string; reason: string }>;
  /** The snapshots reviewed against their previous snapshot, and which one it was. */
  snapshotDiffs: Array<{ path: string; previous: string }>;
}

type RebuildOutcome =
  | { path: string; patch: string; previous?: string }
  | { path: string; reason: string }
  | { path: string; unchanged: true };
/**
 * Rebuilds the patches of the files GitHub left out. A file is a candidate when it has no patch,
 * has changes, has a text status (added, modified, renamed, copied) and is not a sensitive path.
 * The other files are returned unchanged, and a file whose patch cannot be rebuilt keeps the
 * "patch truncated" reason of the review.
 */
export async function rebuildMissingPatches(
  client: GitHubClient,
  files: PullRequestFile[],
  opts: RebuildPatchesOptions,
): Promise<RebuildPatchesResult> {
  const candidates = files.filter(isCandidate);
  const rebuilt: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const snapshotDiffs: Array<{ path: string; previous: string }> = [];
  const patches = new Map<string, string>();

  // At most four reads at a time, so a pull request with many big files stays polite.
  for (let start = 0; start < candidates.length; start += MAX_CONCURRENT_READS) {
    const group = candidates.slice(start, start + MAX_CONCURRENT_READS);
    const outcomes = await Promise.all(group.map((file) => rebuildOne(client, file, opts)));
    for (const outcome of outcomes) {
      if ('patch' in outcome) {
        patches.set(outcome.path, outcome.patch);
        rebuilt.push(outcome.path);
        if (outcome.previous !== undefined) {
          snapshotDiffs.push({ path: outcome.path, previous: outcome.previous });
        }
      } else if ('reason' in outcome) {
        failed.push({ path: outcome.path, reason: outcome.reason });
      }
    }
  }

  return {
    files: files.map((file) => {
      const patch = patches.get(file.path);
      return patch === undefined ? file : { ...file, patch };
    }),
    rebuilt,
    failed,
    snapshotDiffs,
  };
}

/** A file whose patch GitHub left out and that can be rebuilt from its contents. */
function isCandidate(file: PullRequestFile): boolean {
  if (file.changes <= 0) return false;
  if (!REBUILDABLE_STATUSES.has(file.status)) return false;
  if (isSensitivePath(file.path)) return false;
  // A snapshot is rebuilt even when GitHub sent a patch: that patch is the whole new file, and
  // only the regions that differ from the previous snapshot are worth reviewing.
  if (snapshotOf(file)) return true;
  return !file.patch;
}

/** The rebuilt patch of one file; a failure never stops the review. */
async function rebuildOne(
  client: GitHubClient,
  file: PullRequestFile,
  opts: RebuildPatchesOptions,
): Promise<RebuildOutcome> {
  try {
    if (file.status === 'added') {
      const snapshot = await snapshotOutcome(client, file, opts);
      if (snapshot.kind === 'diff') {
        return { path: file.path, patch: snapshot.patch, previous: snapshot.previous };
      }
      if (snapshot.kind === 'same') {
        return { path: file.path, reason: `no content change from ${snapshot.previous}` };
      }
      // Without a previous snapshot the file is rebuilt like any other added file.
      if (file.patch) return { path: file.path, unchanged: true };
      const head = await readAtRef(client, opts.owner, opts.repo, opts.headSha, file.path);
      if (head === null) return { path: file.path, reason: NOT_RETURNED };
      if (isBinary(head)) return { path: file.path, reason: BINARY };
      const patch = addedPatch(head);
      return patch === undefined ? { path: file.path, reason: TOO_LARGE } : { path: file.path, patch };
    }
    // A rename or a copy is read at the path it had in the base commit.
    const basePath = file.previousPath ?? file.path;
    const base = await readAtRef(client, opts.owner, opts.repo, opts.baseSha, basePath);
    const head = await readAtRef(client, opts.owner, opts.repo, opts.headSha, file.path);
    if (base === null || head === null) return { path: file.path, reason: NOT_RETURNED };
    if (isBinary(base) || isBinary(head)) return { path: file.path, reason: BINARY };
    const patch = modifiedPatch(base, head);
    if (patch === undefined) return { path: file.path, reason: TOO_LARGE };
    if (patch === '') return { path: file.path, reason: NO_CHANGE };
    return { path: file.path, patch };
  } catch {
    // A read that fails (a rate limit, a 5xx) leaves the file as it was.
    return { path: file.path, reason: NOT_RETURNED };
  }
}

/** Binary content: a NUL byte in the text. */
function isBinary(content: string): boolean {
  return content.includes('\0');
}

/** A new file: its whole content as one hunk of added lines. */
function addedPatch(content: string): string | undefined {
  const endsWithNewline = content.endsWith('\n');
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const lines = body === '' ? [] : body.split('\n');
  const patch = [
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(endsWithNewline || lines.length === 0 ? [] : ['\\ No newline at end of file']),
  ].join('\n');
  return lineCount(patch) > MAX_REBUILT_PATCH_LINES ? undefined : patch;
}

/** A changed file: the hunks between the base content and the head content, without file headers. */
function modifiedPatch(base: string, head: string): string | undefined {
  const diff = structuredPatch('', '', base, head, '', '', { context: 3 });
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunkLines(hunk.lines));
  }
  const patch = lines.join('\n');
  return lineCount(patch) > MAX_REBUILT_PATCH_LINES ? undefined : patch;
}

/** The body lines of a hunk, without the line breaks the diff kept in them. */
function hunkLines(lines: string[]): string[] {
  const body: string[] = [];
  for (const line of lines) {
    const parts = line.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    body.push(...parts);
  }
  return body;
}

/** How many lines a patch text has. */
function lineCount(patch: string): number {
  return patch.split('\n').length;
}

/** The snapshot an added file is: its number and the folder it lives in. */
function snapshotOf(file: PullRequestFile): { number: number; folder: string } | null {
  if (file.status !== 'added') return null;
  const digits = SNAPSHOT_PATH_RE.exec(file.path)?.[2];
  if (!digits) return null;
  return { number: Number(digits), folder: folderOf(file.path) };
}

/** The folder a file is in. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

type SnapshotOutcome =
  | { kind: 'diff'; patch: string; previous: string }
  | { kind: 'same'; previous: string }
  | { kind: 'none' };

/**
 * The diff of a snapshot against the previous snapshot of the same folder: the snapshot is a new
 * file in the pull request, so the patch holds the new file's side only (ADR-0045, rule 5).
 */
async function snapshotOutcome(
  client: GitHubClient,
  file: PullRequestFile,
  opts: RebuildPatchesOptions,
): Promise<SnapshotOutcome> {
  const snapshot = snapshotOf(file);
  if (!snapshot) return { kind: 'none' };
  try {
    const previous = await findPreviousSnapshot(client, snapshot, opts);
    if (!previous) return { kind: 'none' };
    const before = await readAtRef(client, opts.owner, opts.repo, previous.sha, previous.path);
    if (before === null) return { kind: 'none' };
    const after = await readAtRef(client, opts.owner, opts.repo, opts.headSha, file.path);
    if (after === null) return { kind: 'none' };
    if (isBinary(before) || isBinary(after)) return { kind: 'none' };
    const patch = snapshotPatch(before, after, previous.name);
    if (patch.kind === 'same') return { kind: 'same', previous: previous.name };
    if (patch.kind === 'large') return { kind: 'none' };
    return { kind: 'diff', patch: patch.text, previous: previous.name };
  } catch {
    // A read that fails leaves the file to the added-file rebuild.
    return { kind: 'none' };
  }
}

/**
 * The previous snapshot of a snapshot file: the highest number below it in the same folder, taken
 * from the base commit, or from the head commit when the base has no earlier snapshot.
 */
async function findPreviousSnapshot(
  client: GitHubClient,
  snapshot: { number: number; folder: string },
  opts: RebuildPatchesOptions,
): Promise<{ name: string; path: string; sha: string } | null> {
  const base = await listAtRef(client, opts.owner, opts.repo, opts.baseSha, snapshot.folder);
  const fromBase = previousSnapshotIn(base, snapshot.number);
  if (fromBase) {
    return { name: fromBase, path: `${snapshot.folder}/${fromBase}`, sha: opts.baseSha };
  }
  const head = await listAtRef(client, opts.owner, opts.repo, opts.headSha, snapshot.folder);
  const fromHead = previousSnapshotIn(head, snapshot.number);
  if (fromHead) {
    return { name: fromHead, path: `${snapshot.folder}/${fromHead}`, sha: opts.headSha };
  }
  return null;
}

/** The snapshot of a folder listing with the highest number below `number`. */
function previousSnapshotIn(files: string[] | null, number: number): string | null {
  if (!files) return null;
  let best: string | null = null;
  let bestNumber = -1;
  for (const file of files) {
    const digits = SNAPSHOT_NAME_RE.exec(file.slice(file.lastIndexOf('/') + 1))?.[1];
    if (!digits) continue;
    const value = Number(digits);
    if (value >= number || value <= bestNumber) continue;
    bestNumber = value;
    best = `${digits}_snapshot.json`;
  }
  return best;
}

type SnapshotPatch =
  | { kind: 'text'; text: string }
  | { kind: 'same' }
  | { kind: 'large' };

/**
 * The regions where a snapshot differs from the previous one, as the new file's side: every line
 * it holds is an added line of the new file, with the new file's own line numbers.
 */
function snapshotPatch(before: string, after: string, previousName: string): SnapshotPatch {
  const diff = structuredPatch('', '', before, after, '', '', { context: 3 });
  const lines: string[] = [];
  let hunks = 0;
  for (const hunk of diff.hunks) {
    const kept = keptHunkLines(hunk.lines);
    if (kept.count === 0) continue;
    const header = `@@ -0,0 +${hunk.newStart},${kept.count} @@`;
    lines.push(
      hunks === 0
        ? `${header} compared with ${previousName}: only the regions that differ are shown`
        : header,
    );
    hunks++;
    lines.push(...kept.lines);
  }
  if (hunks === 0) return { kind: 'same' };
  const text = lines.join('\n');
  if (lineCount(text) > MAX_REBUILT_PATCH_LINES) return { kind: 'large' };
  return { kind: 'text', text };
}

/**
 * The lines of a hunk on the new file's side: the context and added lines become added lines, and
 * the removed lines are dropped with the marker that follows them.
 */
function keptHunkLines(lines: string[]): { lines: string[]; count: number } {
  const kept: string[] = [];
  let count = 0;
  let keptLast = false;
  for (const line of hunkLines(lines)) {
    if (line.startsWith('\\')) {
      // The marker belongs to the line before it: it stays only when that line was kept.
      if (keptLast) kept.push(line);
      continue;
    }
    if (line.startsWith('-')) {
      keptLast = false;
      continue;
    }
    if (line.startsWith(' ')) {
      kept.push(`+${line.slice(1)}`);
    } else if (line.startsWith('+')) {
      kept.push(line);
    } else {
      kept.push(`+${line}`);
    }
    count++;
    keptLast = true;
  }
  return { lines: kept, count };
}
