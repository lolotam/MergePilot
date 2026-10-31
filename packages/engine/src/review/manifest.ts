/**
 * The PR manifest of a batched review (ADR-0031): every changed file of the pull request with its
 * status, its added and removed line counts and the batch that reviews it, so a batch call knows
 * the files it does not see are reviewed elsewhere, not missing. Paths and statuses come from the
 * PR, so the manifest is shown as UNTRUSTED data; it never carries file content.
 */

import type { Secret } from '../credentials/secret.js';
import { redactSecrets } from '../security/redact.js';

/** At most this many files are listed; the rest are counted on one `+N more` line. */
export const MANIFEST_MAX_FILES = 300;

const MAX_PATH_CHARS = 200;

/** One changed file as the manifest lists it. */
export interface ManifestFile {
  /** The PR path, matched against the batches. */
  path: string;
  /** The path as shown: secret-redacted like every other prompt text. */
  label: string;
  status: string;
  additions: number;
  deletions: number;
  skipReason?: string | undefined;
}

/** What `manifestFileOf` needs of a PR file: GitHub's counts when given, else the patch's. */
export interface ManifestSource {
  path: string;
  status: string;
  patch?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

function countPatchLines(patch: string | undefined, sign: '+' | '-'): number {
  if (!patch) return 0;
  // Only the `--- a/…` / `+++ b/…` file headers before the first hunk are skipped: a changed line
  // whose text is `---` (a Markdown rule) still counts.
  const lines = patch.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  return lines.slice(Math.max(firstHunk, 0)).filter((line) => line.startsWith(sign)).length;
}

/** A PR file as a manifest entry. */
export function manifestFileOf(file: ManifestSource, knownSecrets: readonly Secret[]): ManifestFile {
  return {
    path: file.path,
    label: redactSecrets(file.path, [...knownSecrets]).text,
    status: file.status,
    additions: file.additions ?? countPatchLines(file.patch, '+'),
    deletions: file.deletions ?? countPatchLines(file.patch, '-'),
  };
}

/** One line per entry: control characters cannot start a fake line, long paths keep their end. */
function shown(text: string): string {
  // C0, DEL and C1 controls (NEL), and the Unicode line and paragraph separators.
  const isControl = (ch: string): boolean => {
    const code = ch.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  };
  // Code points, not UTF-16 units: a cut never splits a surrogate pair.
  const chars = [...text].map((ch) => (isControl(ch) ? '?' : ch));
  return chars.length <= MAX_PATH_CHARS ? chars.join('') : `…${chars.slice(chars.length - MAX_PATH_CHARS + 1).join('')}`;
}

/**
 * The manifest text: files in batch order, then the files no batch reviews (removed, excluded,
 * generated, binary or without a patch). Sensitive paths are never passed in.
 */
export function renderManifest(
  files: readonly ManifestFile[],
  batches: ReadonlyArray<ReadonlyArray<{ path: string }>>,
): string {
  const batchOf = new Map<string, number[]>();
  batches.forEach((batch, index) =>
    batch.forEach((f) => {
      const seen = batchOf.get(f.path);
      if (seen) seen.push(index + 1);
      else batchOf.set(f.path, [index + 1]);
    }),
  );
  const lastBatchOf = (path: string): number | undefined => {
    const seen = batchOf.get(path);
    return seen?.[seen.length - 1];
  };
  const order = (f: ManifestFile): number => lastBatchOf(f.path) ?? batches.length + 1;
  const sorted = files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => order(a.file) - order(b.file) || a.index - b.index)
    .map(({ file }) => file);

  const lines = sorted.slice(0, MANIFEST_MAX_FILES).map((f) => {
    const where = whereOf(batchOf.get(f.path));
    return `${where} | ${shown(f.status)} | +${f.additions} -${f.deletions} | ${shown(f.label)}`;
  });
  if (sorted.length > MANIFEST_MAX_FILES) lines.push(`+${sorted.length - MANIFEST_MAX_FILES} more files`);
  return [`${files.length} changed files in ${batches.length} batches (batch | status | lines | path):`, ...lines].join('\n');
}

/**
 * Where a file is reviewed: the batch it is in, or the range of batches when it is in several
 * (a file split into parts is reviewed in one batch per part).
 */
function whereOf(batches: number[] | undefined): string {
  if (!batches || batches.length === 0) return 'not reviewed';
  const first = batches[0]!;
  const last = batches[batches.length - 1]!;
  return first === last ? `batch ${first}` : `batches ${first}–${last}`;
}

/** Small shared disclosure, included in the existing input-token accounting. */
export const NOT_SHOWN_RULE = 'CHANGED_BUT_NOT_SHOWN lists files that ARE changed in this pull request. Never report them as not updated, missing or unchanged. Their contents are not shown; make no claims about their contents.';

export function renderNotShown(files: readonly ManifestFile[]): string {
  const skipped = files.filter((file) => file.skipReason);
  if (skipped.length === 0) return '';
  const lines = skipped.slice(0, 50).map((file) =>
    `${shown(file.status)} | +${file.additions} -${file.deletions} | ${shown(file.label)} | ${shown(file.skipReason!)}`,
  );
  if (skipped.length > 50) lines.push(`and ${skipped.length - 50} more`);
  return lines.join('\n');
}
