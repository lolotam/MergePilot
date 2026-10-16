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

/** Why a file is context: the changed file's full version, its test/implementation, an import. */
export type ContextKind = 'changed-file' | 'test-pair' | 'import';

/** Priority a > c > b of ADR-0029: lower goes first. */
const KIND_ORDER: Readonly<Record<ContextKind, number>> = { 'changed-file': 0, 'test-pair': 1, import: 2 };

/** One repository file offered as context, as the caller gathered it. */
export interface RepositoryContextFile {
  path: string;
  content: string;
  reason: string;
  kind: ContextKind;
  /** The reviewed files it was gathered for: a batch gets it only when it holds one of them. */
  forPaths: string[];
}

/** What the summary discloses: every path sent in at least one call, and the ones never sent. */
export interface ContextDisclosure {
  sent: string[];
  leftOut: string[];
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

export interface ContextPlanOptions {
  exclude: string[];
  knownSecrets: Secret[];
  /** The files this review covers (after the review's own classification). */
  reviewedPaths: readonly string[];
  /** `review.contextTokens`: the cap of the whole-PR call; 0 sends nothing. */
  contextTokens: number;
  /** `review.batchTokens`: a batch gets at most `min(contextTokens, batchTokens)`. */
  batchTokens: number;
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

/** Filters, redacts and caps the offered files, sorted in send order. */
function prepare(files: readonly RepositoryContextFile[], opts: ContextPlanOptions): PreparedContextFile[] {
  const reviewed = new Set(opts.reviewedPaths);
  const maxFileTokens = Math.min(CONTEXT_FILE_MAX_TOKENS, opts.contextTokens) - BLOCK_OVERHEAD_TOKENS;
  const prepared: PreparedContextFile[] = [];
  for (const file of dedupeByPath(files)) {
    const forPaths = file.forPaths.filter((p) => reviewed.has(p));
    if (forPaths.length === 0 || file.content.includes('\u0000')) continue;
    if (!isContextPathAllowed(file.path, { exclude: opts.exclude, isSensitivePath })) continue;
    const redacted = redactSecrets(file.content, opts.knownSecrets).text;
    const shown = cutAtLineBreak({ path: file.path, content: redacted, reason: file.reason }, maxFileTokens);
    const tokens = estimateTokens(renderContextFile(shown)) + BLOCK_OVERHEAD_TOKENS;
    prepared.push({ ...shown, kind: file.kind, forPaths, tokens });
  }
  const depth = (path: string): number => path.split('/').length;
  return prepared.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      depth(a.path) - depth(b.path) ||
      a.tokens - b.tokens ||
      (a.path < b.path ? -1 : 1),
  );
}

/** The context of one review: what each call gets, and what was sent across all of them. */
export class ContextPlan {
  private readonly files: PreparedContextFile[];
  private readonly sent = new Map<string, ContextFile>();

  constructor(
    offered: readonly RepositoryContextFile[],
    private readonly opts: ContextPlanOptions,
  ) {
    this.files = opts.contextTokens > 0 ? prepare(offered, opts) : [];
  }

  /** The files for a call reviewing `paths`, in send order, within `maxTokens`; not recorded. */
  select(paths: readonly string[], maxTokens: number): ContextFile[] {
    const wanted = new Set(paths);
    const chosen: ContextFile[] = [];
    let left = maxTokens;
    for (const file of this.files) {
      if (file.tokens > left || !file.forPaths.some((p) => wanted.has(p))) continue;
      // Not even its first line fit the per-file cap (a one-line or minified file): sending an
      // empty block would count it as sent; it stays left out instead.
      if (file.truncated && file.content === '') continue;
      // An added file imported by another file of this call: its patch here already shows all of it.
      if (file.kind !== 'changed-file' && wanted.has(file.path)) continue;
      chosen.push({ path: file.path, content: file.content, reason: file.reason, truncated: file.truncated });
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
    for (const file of files) this.sent.set(file.path, file);
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

  /** Sent and left-out paths; undefined when no context was offered. */
  disclosure(): ContextDisclosure | undefined {
    if (this.files.length === 0) return undefined;
    return {
      sent: [...this.sent.keys()],
      leftOut: this.files.filter((f) => !this.sent.has(f.path)).map((f) => f.path),
    };
  }
}
