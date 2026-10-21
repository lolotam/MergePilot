/**
 * Repository context for reviews (ADR-0029): files outside the diff that the caller read at the PR
 * head. Here they are filtered by the review's own skip rules, secret-redacted, cut to a per-file
 * cap, and fitted to each review call's token cap in priority order: the full version of a changed
 * file, then the files it cites or names, then its sibling test or implementation and its local
 * imports (ADR-0041). A plan records what was sent across every call, so the summary can say how
 * many files went and how many did not.
 *
 * Pure engine code: the content arrives through `RunReviewInput.contextFiles`.
 */

import type { Secret } from '../credentials/secret.js';
import { isContextPathAllowed } from '../diff/classify-file.js';
import { redactSecrets } from '../security/redact.js';
import { isSensitivePath } from '../security/sensitive-path.js';
import { estimateTokens } from './budget.js';
import { renderContextFile, type ContextFile } from './prompt.js';

/**
 * Why a file is context: the changed file's full version, its test/implementation, a citation, an
 * import, the build and CI wiring of a PR that changes scripts, tests or CI (ADR-0029), or, on a
 * follow-up review, another file the pull request changes (ADR-0030). `referenced` is a file named
 * in a hunk's context line, in the pull request description, or a code file a changed doc names
 * (ADR-0041).
 */
export type ContextKind = 'changed-file' | 'test-pair' | 'cited' | 'referenced' | 'import' | 'build-config' | 'pr-change';

/**
 * ADR-0041 priority: changed > cited > referenced > test > import > build. PR files are planned
 * apart (ADR-0030).
 */
const KIND_ORDER: Readonly<Record<ContextKind, number>> = {
  'changed-file': 0,
  cited: 1,
  referenced: 2,
  'test-pair': 3,
  import: 4,
  'build-config': 5,
  'pr-change': 6,
};

/** One repository file offered as context, as the caller gathered it. */
export interface RepositoryContextFile {
  path: string;
  /** The file at the head; for `pr-change`, the pull request's unified patch of the file. */
  content: string;
  reason: string;
  kind: ContextKind;
  /**
   * The reviewed files it was gathered for: a batch gets it only when it holds one of them. For
   * `pr-change`, the reviewed files it relates to (import, imported by, same directory): those go
   * first, and a PR file related to none is still offered to every call, after them.
   */
  forPaths: string[];
}

/** Sent and left-out paths of one kind of context. */
export interface ContextPaths {
  sent: string[];
  leftOut: string[];
}

/**
 * What the summary discloses: every repository path sent in at least one call, and the ones never
 * sent; on a follow-up review, the same for the pull request's other changed files (`pr`) and the
 * open findings shown (ADR-0030; the caller fills `openFindings`, it gathered them).
 */
export interface ContextDisclosure extends ContextPaths {
  pr?: ContextPaths | undefined;
  /**
   * The repository paths sent that came in by citation or reference (kinds `cited` and
   * `referenced`).
   */
  cited?: string[] | undefined;
  /**
   * Ids of the open findings shown; `total` how many were open when that is more than were shown;
   * `unchecked` when their thread status could not be read.
   */
  openFindings?: { shown: string[]; total?: number | undefined; unchecked?: boolean | undefined } | undefined;
}

/** A single context file never takes more than this many estimated tokens; longer ones are cut. */
export const CONTEXT_FILE_MAX_TOKENS = 8_000;
export const MAX_SCALED_CONTEXT_TOKENS = 400_000;

/** Opt-in whole-PR scaling; a zero context budget still disables context. */
export function scaledContextTokens(contextTokens: number, perFile: number, reviewedFileCount: number): number {
  return contextTokens > 0 && perFile > 0
    ? Math.min(contextTokens + perFile * reviewedFileCount, MAX_SCALED_CONTEXT_TOKENS)
    : contextTokens;
}

/** The UNTRUSTED fence and label around each block, counted with its content. */
const BLOCK_OVERHEAD_TOKENS = 30;

interface PreparedContextFile extends ContextFile {
  kind: ContextKind;
  forPaths: string[];
  tokens: number;
}

/** A context block's identity: the same path may be both a repository file and a PR diff. */
const blockKey = (file: Pick<ContextFile, 'path' | 'source'>): string => `${file.source ?? 'repository'}:${file.path}`;

export interface ContextPlanOptions {
  exclude: string[];
  knownSecrets: Secret[];
  /** The files this review covers (after the review's own classification). */
  reviewedPaths: readonly string[];
  /** `review.contextTokens`: the base cap; whole-PR scaling is opt-in. 0 sends nothing. */
  contextTokens: number;
  /** Diff batch cap, also the default context cap when `batchContextTokens` is absent. */
  batchTokens: number;
  batchContextTokens?: number | undefined;
  contextTokensPerFile?: number | undefined;
  /**
   * `review.prContextTokens` on a follow-up review: the share of each call's cap that `pr-change`
   * files may take; repository context fills the rest. 0 or absent: no PR context (ADR-0030).
   */
  prContextTokens?: number | undefined;
}

/** Cuts content at a line break so its rendered block fits `maxTokens`. */
function cutAtLineBreak(file: ContextFile, maxTokens: number): ContextFile {
  if (estimateTokens(renderContextFile(file)) <= maxTokens) return file;
  const kept: string[] = [];
  let used = estimateTokens(renderContextFile({ ...file, content: '', truncated: true }));
  for (const line of file.content.split(/\r?\n/)) {
    const cost = estimateTokens(`  ${kept.length + 1}   ${line}\n`);
    if (used + cost > maxTokens) break;
    kept.push(line);
    used += cost;
  }
  return { ...file, content: kept.join('\n'), truncated: true };
}

/** Merges duplicates by path: the highest-priority reason wins, the reviewed paths are united. */
function dedupeByPath(files: readonly RepositoryContextFile[]): RepositoryContextFile[] {
  const byPath = new Map<string, RepositoryContextFile>();
  for (const file of files) {
    if (file.kind === 'pr-change') continue;
    const known = byPath.get(file.path);
    if (!known) {
      byPath.set(file.path, { ...file, forPaths: [...file.forPaths] });
      continue;
    }
    const forPaths = [...new Set([...known.forPaths, ...file.forPaths])];
    const better = KIND_ORDER[file.kind] < KIND_ORDER[known.kind] ? file : known;
    byPath.set(file.path, { ...better, forPaths });
  }
  return [...byPath.values()];
}

/** Filters, redacts and cuts one offered file to `maxFileTokens`; undefined when it may not be sent. */
function prepareOne(
  file: RepositoryContextFile,
  forPaths: string[],
  maxFileTokens: number,
  opts: ContextPlanOptions,
): PreparedContextFile | undefined {
  if (file.content.includes('\u0000')) return undefined;
  if (!isContextPathAllowed(file.path, { exclude: opts.exclude, isSensitivePath })) return undefined;
  const redacted = redactSecrets(file.content, opts.knownSecrets).text;
  const source = file.kind === 'pr-change' ? ({ source: 'pull-request' } as const) : {};
  const shown = cutAtLineBreak({ path: file.path, content: redacted, reason: file.reason, ...source }, maxFileTokens);
  const tokens = estimateTokens(renderContextFile(shown)) + BLOCK_OVERHEAD_TOKENS;
  return { ...shown, kind: file.kind, forPaths, tokens };
}

const depth = (path: string): number => path.split('/').length;
/** Shallower, then smaller, then by path. */
const bySize = (a: PreparedContextFile, b: PreparedContextFile): number =>
  depth(a.path) - depth(b.path) || a.tokens - b.tokens || (a.path < b.path ? -1 : 1);

/** Filters, redacts and caps the offered repository files, sorted in send order. */
function prepareRepository(files: readonly RepositoryContextFile[], opts: ContextPlanOptions): PreparedContextFile[] {
  const reviewed = new Set(opts.reviewedPaths);
  const maxFileTokens = Math.min(CONTEXT_FILE_MAX_TOKENS, opts.contextTokens) - BLOCK_OVERHEAD_TOKENS;
  const prepared: PreparedContextFile[] = [];
  for (const file of dedupeByPath(files)) {
    const forPaths = file.forPaths.filter((p) => reviewed.has(p));
    const one = forPaths.length > 0 ? prepareOne(file, forPaths, maxFileTokens, opts) : undefined;
    if (one) prepared.push(one);
  }
  return prepared.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || bySize(a, b));
}

/**
 * The pull request's other changed files (ADR-0030), never one this review covers, each cut to the
 * PR share. A file related to no reviewed file is kept: it goes to every call, after the related.
 */
function preparePullRequest(files: readonly RepositoryContextFile[], opts: ContextPlanOptions): PreparedContextFile[] {
  const share = Math.min(opts.prContextTokens ?? 0, opts.contextTokens);
  if (share <= 0) return [];
  const reviewed = new Set(opts.reviewedPaths);
  const maxFileTokens = Math.min(CONTEXT_FILE_MAX_TOKENS, share) - BLOCK_OVERHEAD_TOKENS;
  const seen = new Set<string>();
  const prepared: PreparedContextFile[] = [];
  for (const file of files) {
    if (file.kind !== 'pr-change' || reviewed.has(file.path) || seen.has(file.path)) continue;
    seen.add(file.path);
    const one = prepareOne(file, file.forPaths.filter((p) => reviewed.has(p)), maxFileTokens, opts);
    if (one) prepared.push(one);
  }
  return prepared.sort(bySize);
}

const shownOf = (file: PreparedContextFile): ContextFile => ({
  path: file.path,
  content: file.content,
  reason: file.reason,
  truncated: file.truncated,
  ...(file.source ? { source: file.source } : {}),
});

/** The context of one review: what each call gets, and what was sent across all of them. */
export class ContextPlan {
  private readonly files: PreparedContextFile[];
  private readonly prFiles: PreparedContextFile[];
  /** The offered paths that came in by citation or reference (ADR-0041). */
  private readonly citedPaths: Set<string>;
  private batchContext: { files: PreparedContextFile[]; prFiles: PreparedContextFile[] } | undefined;
  private readonly sent = new Map<string, ContextFile>();
  /** Context skipped because the file's own patch was in the call: shown, so never left out. */
  private readonly shownAsPatch = new Set<string>();

  constructor(
    private readonly offered: readonly RepositoryContextFile[],
    private readonly opts: ContextPlanOptions,
  ) {
    const on = opts.contextTokens > 0;
    this.files = on ? prepareRepository(offered, { ...opts, contextTokens: this.wholeCap() }) : [];
    this.prFiles = on ? preparePullRequest(offered, opts) : [];
    // From the offered files, not the merged ones: a changed file another file cites keeps the
    // `changed-file` kind after the merge but was still sent because of that citation.
    this.citedPaths = new Set(
      offered.filter((f) => f.kind === 'cited' || f.kind === 'referenced').map((f) => f.path),
    );
  }

  /**
   * The context of a call reviewing `paths`, in send order, within `maxTokens`; not recorded. PR
   * context first (files related to `paths` first) within the PR share; repository files fill the rest.
   */
  select(paths: readonly string[], maxTokens: number): ContextFile[] {
    return this.selectPrepared(paths, maxTokens, this.files, this.prFiles);
  }

  private selectPrepared(
    paths: readonly string[],
    maxTokens: number,
    files: readonly PreparedContextFile[],
    prFiles: readonly PreparedContextFile[],
  ): ContextFile[] {
    const wanted = new Set(paths);
    const related = (file: PreparedContextFile): boolean => file.forPaths.some((p) => wanted.has(p));
    const chosen: ContextFile[] = [];
    let prLeft = Math.min(this.opts.prContextTokens ?? 0, this.opts.contextTokens, maxTokens);
    let left = maxTokens;
    for (const file of [...prFiles.filter(related), ...prFiles.filter((f) => !related(f))]) {
      if (file.tokens > prLeft) continue;
      // As for repository context: a patch of which not one changed or context line fit (only its
      // hunk header, or nothing) is left out instead of being counted as sent.
      if (file.truncated && file.content.split('\n').every((line) => line === '' || line.startsWith('@@'))) continue;
      chosen.push(shownOf(file));
      prLeft -= file.tokens;
      left -= file.tokens;
    }
    for (const file of files) {
      if (file.tokens > left || !related(file)) continue;
      // Not even its first line fit the per-file cap (a one-line or minified file): sending an
      // empty block would count it as sent; it stays left out instead.
      if (file.truncated && file.content === '') continue;
      // An added file imported by another file of this call: its patch here already shows all of it.
      if (file.kind !== 'changed-file' && wanted.has(file.path)) {
        this.shownAsPatch.add(file.path);
        continue;
      }
      chosen.push(shownOf(file));
      left -= file.tokens;
    }
    return chosen;
  }

  /** The context of the whole-PR call (not yet recorded: the call may be replaced by batches). */
  whole(maxTokens = Infinity): ContextFile[] {
    return this.select(this.opts.reviewedPaths, Math.min(this.wholeCap(), maxTokens));
  }

  private wholeCap(): number {
    return scaledContextTokens(this.opts.contextTokens, this.opts.contextTokensPerFile ?? 0, this.opts.reviewedPaths.length);
  }

  /** Records files as sent, retaining the longest version for verification after batch recovery. */
  markSent(files: readonly ContextFile[]): void {
    for (const file of files) {
      const key = blockKey(file);
      const previous = this.sent.get(key);
      if (!previous || file.content.length > previous.content.length || (previous.truncated && !file.truncated)) {
        this.sent.set(key, file);
      }
    }
  }

  /** The context of one batch, from its own files' context, recorded as sent. */
  readonly forBatch = (batch: ReadonlyArray<{ path: string }>): ContextFile[] => {
    const cap = Math.min(this.opts.contextTokens, this.opts.batchContextTokens ?? this.opts.batchTokens);
    if (!this.batchContext) {
      const batchOpts = { ...this.opts, contextTokens: cap };
      this.batchContext = {
        files: cap > 0 ? prepareRepository(this.offered, batchOpts) : [],
        prFiles: cap > 0 ? preparePullRequest(this.offered, batchOpts) : [],
      };
    }
    const files = this.selectPrepared(batch.map((f) => f.path), cap, this.batchContext.files, this.batchContext.prFiles);
    this.markSent(files);
    return files;
  };

  /** Every file sent in at least one call: what the verify pass may show. */
  sentFiles(): ContextFile[] {
    return [...this.sent.values()];
  }

  /** Sent and left-out paths, repository and PR context apart; undefined when nothing was offered. */
  disclosure(): ContextDisclosure | undefined {
    if (this.files.length === 0 && this.prFiles.length === 0) return undefined;
    // Sent paths in the order they were first sent.
    const sent = [...this.sent.values()];
    const sentPrPaths = sent.filter((f) => f.source === 'pull-request').map((f) => f.path);
    const sentRepositoryPaths = sent.filter((f) => f.source !== 'pull-request').map((f) => f.path);
    const leftOutOf = (files: readonly PreparedContextFile[]): string[] =>
      files.filter((f) => !this.sent.has(blockKey(f)) && !this.shownAsPatch.has(f.path)).map((f) => f.path);
    // Files from outside the diff first: the summary names only five, and a description often
    // names the changed files themselves, which were sent anyway.
    const reviewed = new Set(this.opts.reviewedPaths);
    const citedSent = sentRepositoryPaths.filter((p) => this.citedPaths.has(p));
    const cited = [...citedSent.filter((p) => !reviewed.has(p)), ...citedSent.filter((p) => reviewed.has(p))];
    return {
      sent: sentRepositoryPaths,
      leftOut: leftOutOf(this.files),
      ...(cited.length > 0 ? { cited } : {}),
      ...(this.prFiles.length > 0 ? { pr: { sent: sentPrPaths, leftOut: leftOutOf(this.prFiles) } } : {}),
    };
  }
}
