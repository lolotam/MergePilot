/**
 * The rest of the pull request on a follow-up review (ADR-0030): every file the PR changes that
 * this incremental run does not review is offered as `pr-change` context, with its PR patch as the
 * content. Files related to a reviewed file go first: one imports the other, or both sit in the
 * same directory. Relations are found by text in what is already at hand (the reviewed files' head
 * content, the patches' new side), so this costs no GitHub read; nothing is parsed or run.
 */
import { classifyFile, isSensitivePath, type RepositoryContextFile } from '@mergepilot/engine';
import { dirOf, importCandidateGroups, patchNewSide, type ReviewedFile } from './review-context.js';

export interface PullRequestContextParams {
  /** The files this run reviews: the changes since the last reviewed head. */
  reviewed: readonly ReviewedFile[];
  /** Every file of the PR diff (base...head), with its PR patch. */
  prFiles: readonly ReviewedFile[];
  /** `review.exclude`: an excluded file is not reviewed, so it is not context either. */
  exclude: string[];
  /** Head content of reviewed files already read for repository context, by path. */
  headContent?: ReadonlyMap<string, string> | undefined;
}

export const PR_CONTEXT_REASON = 'changed earlier in this pull request';

interface Imports {
  path: string;
  /** Every candidate path of every local import. */
  imports: Set<string>;
}

const importsOf = (path: string, content: string): Imports => ({
  path,
  imports: new Set(importCandidateGroups(path, content).flat()),
});

/** How a PR file relates to a reviewed file, for the context block's reason. */
function relationOf(reviewed: Imports, other: Imports): string | undefined {
  if (reviewed.imports.has(other.path)) return `imported by ${reviewed.path}`;
  if (other.imports.has(reviewed.path)) return `imports ${reviewed.path}`;
  if (dirOf(reviewed.path) === dirOf(other.path)) return `same directory as ${reviewed.path}`;
  return undefined;
}

/** The PR's other changed files as `pr-change` context; the engine fits them to `review.prContextTokens`. */
export function pullRequestContextFiles(params: PullRequestContextParams): RepositoryContextFile[] {
  const reviewedPaths = new Set(params.reviewed.map((f) => f.path));
  const prPatches = new Map(params.prFiles.map((f) => [f.path, f.patch]));
  // A reviewed file's imports: its head content when read, else the new side of its PR patch.
  const reviewed = params.reviewed.map((f) =>
    importsOf(f.path, params.headContent?.get(f.path) ?? patchNewSide(prPatches.get(f.path) ?? f.patch ?? '')),
  );
  const files: RepositoryContextFile[] = [];
  for (const file of params.prFiles) {
    if (reviewedPaths.has(file.path) || !file.patch) continue;
    if (classifyFile(file, { exclude: params.exclude, isSensitivePath }) !== 'review') continue;
    const other = importsOf(file.path, patchNewSide(file.patch));
    const relations = reviewed.flatMap((r) => {
      const why = relationOf(r, other);
      return why ? [{ path: r.path, why }] : [];
    });
    files.push({
      path: file.path,
      content: file.patch,
      reason: relations[0] ? `${PR_CONTEXT_REASON}; ${relations[0].why}` : PR_CONTEXT_REASON,
      kind: 'pr-change',
      forPaths: relations.map((r) => r.path),
    });
  }
  return files;
}
