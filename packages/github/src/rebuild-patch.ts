/**
 * Rebuilding the patch GitHub left out (ADR-0045): the pull request files API omits the patch of
 * a file whose diff is too big, so the bots would see nothing of it. The patch is rebuilt from the
 * file contents at the pull request's base and head commits, and used like any GitHub patch.
 * A drizzle migration snapshot is a whole copy of the schema, so it is reviewed only where it
 * differs from the previous snapshot of the same folder (ADR-0045, rule 5).
 */
import { classifyFile, isSensitivePath } from '@mergepilot/engine';
import { structuredPatch } from 'diff';
import type { GitHubClient } from './client.js';
import type { PullRequestFile } from './pr-files.js';
import { listAtRef, readAtRef } from './read-cache.js';

/** The most diff lines a rebuilt patch may have; a bigger one is not used (ADR-0045). */
export const MAX_REBUILT_PATCH_LINES = 50_000;

/** How long a diff may run before it is given up on (milliseconds). */
export const DIFF_TIMEOUT_MS = 2_000;

/** The most edits a diff may compute; a bigger one is given up on. */
export const MAX_DIFF_EDIT_LENGTH = 20_000;

/** The options every diff runs with: three context lines, and a bound on what it may cost. */
const DIFF_OPTIONS = { context: 3, timeout: DIFF_TIMEOUT_MS, maxEditLength: MAX_DIFF_EDIT_LENGTH };

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
const DIFF_TOO_COSTLY = 'diff too costly to compute';

export interface RebuildPatchesOptions {
  owner: string;
  repo: string;
  /** The pull request's base commit: where the old content is read. */
  baseSha: string;
  /** The pull request's head commit: where the new content is read. */
  headSha: string;
  /** The paths the review excludes (`review.exclude`): their content is never read. */
  exclude?: string[];
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
  // `dropPatch`: the file's patch is dropped, so the review sees no patch at all.
  | { path: string; reason: string; dropPatch?: boolean }
  | { path: string; unchanged: true };

/**
 * Rebuilds the patches of the files GitHub left out. A file is a candidate when it has no patch,
 * has changes, has a text status (added, modified, renamed, copied), is not a sensitive path and
 * is not excluded or generated. The other files are returned unchanged, and a file whose patch
 * cannot be rebuilt keeps the "patch truncated" reason of the review.
 */
export async function rebuildMissingPatches(
  client: GitHubClient,
  files: PullRequestFile[],
  opts: RebuildPatchesOptions,
): Promise<RebuildPatchesResult> {
  const candidates = files.filter((file) => isCandidate(file, opts.exclude ?? []));
  const rebuilt: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  const snapshotDiffs: Array<{ path: string; previous: string }> = [];
  const patches = new Map<string, string>();
  // The files whose patch is dropped: a snapshot whose diff failed is never sent whole.
  const dropped = new Set<string>();
  // The base content is read at the merge base of the pull request, not at the base branch's tip.
  const baseRef = await mergeBaseOf(client, candidates, opts);

  // At most four reads at a time, so a pull request with many big files stays polite.
  for (let start = 0; start < candidates.length; start += MAX_CONCURRENT_READS) {
    const group = candidates.slice(start, start + MAX_CONCURRENT_READS);
    const outcomes = await Promise.all(group.map((file) => rebuildOne(client, file, opts, baseRef)));
    for (const outcome of outcomes) {
      if ('patch' in outcome) {
        patches.set(outcome.path, outcome.patch);
        rebuilt.push(outcome.path);
        if (outcome.previous !== undefined) {
          snapshotDiffs.push({ path: outcome.path, previous: outcome.previous });
        }
      } else if ('reason' in outcome) {
        failed.push({ path: outcome.path, reason: outcome.reason });
        if (outcome.dropPatch) dropped.add(outcome.path);
      }
    }
  }

  return {
    files: files.map((file) => {
      const patch = patches.get(file.path);
      if (patch !== undefined) return { ...file, patch };
      // A dropped patch leaves the file with none: the review reports it as a truncated patch.
      return dropped.has(file.path) ? withoutPatch(file) : file;
    }),
    rebuilt,
    failed,
    snapshotDiffs,
  };
}

/** The file without its patch: the review reports it as a truncated patch. */
function withoutPatch(file: PullRequestFile): PullRequestFile {
  const { patch: _patch, ...rest } = file;
  return rest;
}

/**
 * The commit the base content is read at: the merge base of the pull request, so a change the
 * base branch took after the pull request branched is not in the diff. The base branch's tip is
 * used when the merge base is unknown. Nothing is compared when no candidate reads the base.
 */
async function mergeBaseOf(
  client: GitHubClient,
  candidates: readonly PullRequestFile[],
  opts: RebuildPatchesOptions,
): Promise<string> {
  if (!candidates.some(needsBaseRead)) return opts.baseSha;
  try {
    const compared = client.compareCommits?.({
      owner: opts.owner,
      repo: opts.repo,
      base: opts.baseSha,
      head: opts.headSha,
    });
    // A client without the comparison, or a comparison that fails, leaves the base at its tip.
    const result = await Promise.resolve(compared).catch(() => null);
    return result?.mergeBaseSha ?? opts.baseSha;
  } catch {
    return opts.baseSha;
  }
}

/** Whether the rebuild of a file reads the base commit: its old content, or a folder listing. */
function needsBaseRead(file: PullRequestFile): boolean {
  if (file.status === 'added') return snapshotOf(file) !== null;
  return true;
}

/** A file whose patch GitHub left out and that can be rebuilt from its contents. */
function isCandidate(file: PullRequestFile, exclude: readonly string[]): boolean {
  if (file.changes <= 0) return false;
  if (!REBUILDABLE_STATUSES.has(file.status)) return false;
  if (isSensitivePath(file.path)) return false;
  // A rename reads the file's old path: a sensitive one is never read either.
  if (file.previousPath !== undefined && isSensitivePath(file.previousPath)) return false;
  // An excluded or generated file is not reviewed, so its content is never read.
  const classification = classifyFile(
    { path: file.path, status: file.status, patch: '+', changes: file.changes },
    { exclude: [...exclude], isSensitivePath },
  );
  if (classification !== 'review') return false;
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
  baseRef: string,
): Promise<RebuildOutcome> {
  try {
    if (file.status === 'added') {
      const snapshot = await snapshotOutcome(client, file, opts, baseRef);
      if (snapshot.kind === 'diff') {
        return { path: file.path, patch: snapshot.patch, previous: snapshot.previous };
      }
      if (snapshot.kind === 'same') {
        return { path: file.path, reason: `no content change from ${snapshot.previous}` };
      }
      if (snapshot.kind === 'failed') {
        // The diff against the previous snapshot failed: the snapshot is never reviewed as a
        // whole file (ADR-0045, rule 5). Its patch is dropped, so the review says it is truncated.
        return { path: file.path, reason: `snapshot diff failed (${snapshot.reason})`, dropPatch: true };
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
    const base = await readAtRef(client, opts.owner, opts.repo, baseRef, basePath);
    const head = await readAtRef(client, opts.owner, opts.repo, opts.headSha, file.path);
    if (base === null || head === null) return { path: file.path, reason: NOT_RETURNED };
    if (isBinary(base) || isBinary(head)) return { path: file.path, reason: BINARY };
    const patch = modifiedPatch(base, head);
    if (patch.kind === 'costly') return { path: file.path, reason: DIFF_TOO_COSTLY };
    if (patch.kind === 'large') return { path: file.path, reason: TOO_LARGE };
    if (patch.kind === 'same') return { path: file.path, reason: NO_CHANGE };
    return { path: file.path, patch: patch.patch };
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

/** What a diff between two contents gave: its patch, or why there is none. */
type DiffOutcome =
  | { kind: 'text'; patch: string }
  | { kind: 'same' }
  | { kind: 'large' }
  | { kind: 'costly' };

/** A changed file: the hunks between the base content and the head content, without file headers. */
function modifiedPatch(base: string, head: string): DiffOutcome {
  const diff = structuredPatch('', '', base, head, '', '', DIFF_OPTIONS);
  // The diff gave up: too costly to compute.
  if (!diff) return { kind: 'costly' };
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    lines.push(...hunkLines(hunk.lines));
  }
  const patch = lines.join('\n');
  if (lineCount(patch) > MAX_REBUILT_PATCH_LINES) return { kind: 'large' };
  if (patch === '') return { kind: 'same' };
  return { kind: 'text', patch };
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
  | { kind: 'failed'; reason: SnapshotFailure }
  | { kind: 'none' };

/** Why the diff against the previous snapshot failed. */
type SnapshotFailure = 'large' | 'costly' | 'empty';

/**
 * The diff of a snapshot against the previous snapshot of the same folder: the snapshot is a new
 * file in the pull request, so the patch holds the new file's side only (ADR-0045, rule 5).
 */
async function snapshotOutcome(
  client: GitHubClient,
  file: PullRequestFile,
  opts: RebuildPatchesOptions,
  baseRef: string,
): Promise<SnapshotOutcome> {
  const snapshot = snapshotOf(file);
  if (!snapshot) return { kind: 'none' };
  try {
    const previous = await findPreviousSnapshot(client, snapshot, opts, baseRef);
    if (!previous) return { kind: 'none' };
    const before = await readAtRef(client, opts.owner, opts.repo, previous.sha, previous.path);
    if (before === null) return { kind: 'none' };
    const after = await readAtRef(client, opts.owner, opts.repo, opts.headSha, file.path);
    if (after === null) return { kind: 'none' };
    if (isBinary(before) || isBinary(after)) return { kind: 'none' };
    const patch = snapshotPatch(before, after, previous.name);
    if (patch.kind === 'same') return { kind: 'same', previous: previous.name };
    // The diff failed: the whole snapshot is never sent instead of the regions that differ.
    if (patch.kind === 'empty' || patch.kind === 'large' || patch.kind === 'costly') {
      return { kind: 'failed', reason: patch.kind };
    }
    return { kind: 'diff', patch: patch.text, previous: previous.name };
  } catch {
    // A read that fails leaves the file to the added-file rebuild.
    return { kind: 'none' };
  }
}

/**
 * The previous snapshot of a snapshot file: the highest number below it in the same folder, in
 * the head commit's listing or in the merge base's, whichever has the higher one. The pull
 * request's own snapshot wins, so a pull request that adds two snapshots diffs the newer one
 * against the older one it adds itself.
 */
async function findPreviousSnapshot(
  client: GitHubClient,
  snapshot: { number: number; folder: string },
  opts: RebuildPatchesOptions,
  baseRef: string,
): Promise<{ name: string; path: string; sha: string } | null> {
  // The two listings run one after the other: four candidates at the same time would send eight
  // requests at once, over the four-read cap.
  const base = await listAtRef(client, opts.owner, opts.repo, baseRef, snapshot.folder);
  const head = await listAtRef(client, opts.owner, opts.repo, opts.headSha, snapshot.folder);
  const fromBase = previousSnapshotIn(base, snapshot.number);
  const fromHead = previousSnapshotIn(head, snapshot.number);
  if (fromHead && (!fromBase || fromHead.number >= fromBase.number)) {
    return { name: fromHead.name, path: `${snapshot.folder}/${fromHead.name}`, sha: opts.headSha };
  }
  if (fromBase) {
    return { name: fromBase.name, path: `${snapshot.folder}/${fromBase.name}`, sha: baseRef };
  }
  return null;
}

/** The snapshot of a folder listing with the highest number below `number`. */
function previousSnapshotIn(
  files: string[] | null,
  number: number,
): { name: string; number: number } | null {
  if (!files) return null;
  let best: { name: string; number: number } | null = null;
  for (const file of files) {
    const digits = SNAPSHOT_NAME_RE.exec(file.slice(file.lastIndexOf('/') + 1))?.[1];
    if (!digits) continue;
    const value = Number(digits);
    if (value >= number) continue;
    if (best && value <= best.number) continue;
    best = { name: `${digits}_snapshot.json`, number: value };
  }
  return best;
}

type SnapshotPatch =
  | { kind: 'text'; text: string }
  | { kind: 'same' }
  | { kind: 'empty' }
  | { kind: 'large' }
  | { kind: 'costly' };

/**
 * The regions where a snapshot differs from the previous one, as the new file's side: every line
 * it holds is an added line of the new file, with the new file's own line numbers.
 */
function snapshotPatch(before: string, after: string, previousName: string): SnapshotPatch {
  const diff = structuredPatch('', '', before, after, '', '', DIFF_OPTIONS);
  // The diff gave up: too costly to compute.
  if (!diff) return { kind: 'costly' };
  if (diff.hunks.length === 0) return { kind: 'same' };
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
  if (hunks === 0) return { kind: 'empty' };
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
