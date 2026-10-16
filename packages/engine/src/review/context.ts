/**
 * Repository context for reviews (ADR-0029): files outside the diff that the caller read at the PR
 * head. Here they are filtered by the review's own skip rules, secret-redacted, cut to a per-file
 * cap, and fitted to each review call's token cap in priority order: the full version of a changed
 * file, then its sibling test or implementation, then the local modules it imports. A plan records
 * what was sent across every call, so the summary can say how many files went and how many did not.
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
 * Why a file is context: the changed file's full version, its test/implementation, an import
 * (ADR-0029), or, on a follow-up review, another file the pull request changes (ADR-0030).
 */
export type ContextKind = 'changed-file' | 'test-pair' | 'import' | 'pr-change';

/** Priority a > c > b of ADR-0029: lower goes first. PR files are planned apart (ADR-0030). */
const KIND_ORDER: Readonly<Record<ContextKind, number>> = { 'changed-file': 0, 'test-pair': 1, import: 2, 'pr-change': 3 };

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
  /** Ids of the open findings shown; `unchecked` when their thread status could not be read. */
  openFindings?: { shown: string[]; unchecked?: boolean | undefined } | undefined;
}

/** A single context file never takes more than this many estimated tokens; longer ones are cut. */
export const CONTEXT_FILE_MAX_TOKENS = 8_000;

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
  /** `review.contextTokens`: the cap of the whole-PR call; 0 sends nothing. */
  contextTokens: number;
  /** `review.batchTokens`: a batch gets at most `min(contextTokens, batchTokens)`. */
  batchTokens: number;
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
  private readonly sent = new Map<string, ContextFile>();
  /** Context skipped because the file's own patch was in the call: shown, so never left out. */
  private readonly shownAsPatch = new Set<string>();

  constructor(
    offered: readonly RepositoryContextFile[],
    private readonly opts: ContextPlanOptions,
  ) {
    const on = opts.contextTokens > 0;
    this.files = on ? prepareRepository(offered, opts) : [];
    this.prFiles = on ? preparePullRequest(offered, opts) : [];
  }

  /**
   * The context of a call reviewing `paths`, in send order, within `maxTokens`; not recorded. PR
   * context first (files related to `paths` first) within the PR share; repository files fill the rest.
   */
  select(paths: readonly string[], maxTokens: number): ContextFile[] {
    const wanted = new Set(paths);
    const related = (file: PreparedContextFile): boolean => file.forPaths.some((p) => wanted.has(p));
    const chosen: ContextFile[] = [];
    let prLeft = Math.min(this.opts.prContextTokens ?? 0, maxTokens);
    let left = maxTokens;
    for (const file of [...this.prFiles.filter(related), ...this.prFiles.filter((f) => !related(f))]) {
      if (file.tokens > prLeft) continue;
      chosen.push(shownOf(file));
      prLeft -= file.tokens;
      left -= file.tokens;
    }
    for (const file of this.files) {
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
  whole(): ContextFile[] {
    return this.select(this.opts.reviewedPaths, this.opts.contextTokens);
  }

  /** Records files as sent to the model. */
  markSent(files: readonly ContextFile[]): void {
    for (const file of files) this.sent.set(blockKey(file), file);
  }

  /** The context of one batch, from its own files' context, recorded as sent. */
  readonly forBatch = (batch: ReadonlyArray<{ path: string }>): ContextFile[] => {
    const cap = Math.min(this.opts.contextTokens, this.opts.batchTokens);
    const files = this.select(batch.map((f) => f.path), cap);
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
    return {
      sent: sentRepositoryPaths,
      leftOut: leftOutOf(this.files),
      ...(this.prFiles.length > 0 ? { pr: { sent: sentPrPaths, leftOut: leftOutOf(this.prFiles) } } : {}),
    };
  }
}
