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
  return patch.split('\n').filter((line) => line.startsWith(sign)).length;
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
  const isControl = (ch: string): boolean => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;
  const flat = [...text].map((ch) => (isControl(ch) ? '?' : ch)).join('');
  return flat.length <= MAX_PATH_CHARS ? flat : `…${flat.slice(flat.length - MAX_PATH_CHARS + 1)}`;
}

/**
 * The manifest text: files in batch order, then the files no batch reviews (removed, excluded,
 * generated, binary or without a patch). Sensitive paths are never passed in.
 */
export function renderManifest(
  files: readonly ManifestFile[],
  batches: ReadonlyArray<ReadonlyArray<{ path: string }>>,
): string {
  const batchOf = new Map<string, number>();
  batches.forEach((batch, index) => batch.forEach((f) => batchOf.set(f.path, index + 1)));
  const order = (f: ManifestFile): number => batchOf.get(f.path) ?? batches.length + 1;
  const sorted = files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => order(a.file) - order(b.file) || a.index - b.index)
    .map(({ file }) => file);

  const lines = sorted.slice(0, MANIFEST_MAX_FILES).map((f) => {
    const batch = batchOf.get(f.path);
    const where = batch === undefined ? 'not reviewed' : `batch ${batch}`;
    return `${where} | ${shown(f.status)} | +${f.additions} -${f.deletions} | ${shown(f.label)}`;
  });
  if (sorted.length > MANIFEST_MAX_FILES) lines.push(`+${sorted.length - MANIFEST_MAX_FILES} more files`);
  return [`${files.length} changed files in ${batches.length} batches (batch | status | lines | path):`, ...lines].join('\n');
}
