/**
 * Step a of the review pipeline: sorts the changed files of the pull request into the ones the
 * model reviews, the ones that make the review incomplete, and the PR manifest (ADR-0031).
 */

import type { Secret } from '../credentials/secret.js';
import { classifyFile, isGeneratedArtifactPath, type FileToClassify } from '../diff/classify-file.js';
import { redactSecrets } from '../security/redact.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { manifestFileOf, type ManifestFile, type ManifestSource } from './manifest.js';

export interface ChangedFiles {
  reviewableFiles: Array<{ path: string; patch: string }>;
  incompleteReasons: string[];
  /** Every changed file but sensitive ones, skipped ones with their reason (ADR-0051). */
  manifestFiles: ManifestFile[];
}

/** Redacted labels of changed generated artifacts for which there is no patch to review. */
export function notShownArtifactLabels(
  files: ReadonlyArray<FileToClassify>,
  opts: { exclude: string[]; knownSecrets: readonly Secret[] },
): string[] {
  const classificationOptions = { exclude: opts.exclude, isSensitivePath };
  const secrets = [...opts.knownSecrets];
  return files
    // A missing patch must be the reason for the skip, even when the name matches inside dist/.
    .filter((file) => !file.patch && file.changes > 0 && isGeneratedArtifactPath(file.path)
      && classifyFile({ ...file, patch: '+' }, classificationOptions) === 'review')
    .map((file) => redactSecrets(file.path, secrets).text);
}

export function classifyChangedFiles(
  files: ReadonlyArray<FileToClassify & ManifestSource>,
  opts: { exclude: string[]; knownSecrets: readonly Secret[] },
): ChangedFiles {
  const changed: ChangedFiles = { reviewableFiles: [], incompleteReasons: [], manifestFiles: [] };
  for (const file of files) {
    const classification = classifyFile(file, { exclude: opts.exclude, isSensitivePath });
    // On the path itself, not the classification: a removed or excluded `.env` is classified
    // before sensitivity, and its name must still never reach the model.
    if (!isSensitivePath(file.path)) {
      // A skipped file is still listed, so no bot reports it as unchanged (ADR-0051).
      const skipReason = classification === 'review' ? {} : { skipReason: classification };
      changed.manifestFiles.push({ ...manifestFileOf(file, opts.knownSecrets), ...skipReason });
    }

    if (classification === 'incomplete-truncated') {
      changed.incompleteReasons.push(`${file.path}: patch truncated`);
    } else if (classification === 'review' && file.patch) {
      changed.reviewableFiles.push({ path: file.path, patch: file.patch });
    }
  }
  return changed;
}
