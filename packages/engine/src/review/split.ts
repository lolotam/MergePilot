/**
 * Pure helpers for reviewing a PR in parts: batching files by diff size, merging usage and
 * findings across calls. The calls themselves live in batch-run.ts and truncation.ts.
 */
import { z } from 'zod';
import type { TokenUsage } from '../llm/types.js';
import { FileTier, groupFilesForBatches, type BatchNode } from './batch-groups.js';
import { estimateTokens } from './budget.js';
import { ReviewAnswerSchema } from './answer.js';
import { splitPatchIntoParts } from './patch-parts.js';
import type { Finding } from './types.js';

export interface ReviewableFileWithPatch {
  path: string;
  patch: string;
  /** Set when the file's patch was split into parts (ADR-0045): which part, of how many. */
  part?: { index: number; total: number };
}

export interface RulesFileInput {
  path: string;
  content: string;
}

/** Combines token usage from multiple model calls into a single TokenUsage. */
export function combineUsage(u1?: TokenUsage, u2?: TokenUsage): TokenUsage | undefined {
  if (!u1 && !u2) return undefined;
  if (!u1) return u2;
  if (!u2) return u1;
  return {
    inputTokens: u1.inputTokens + u2.inputTokens,
    outputTokens: u1.outputTokens + u2.outputTokens,
    cacheReadTokens: (u1.cacheReadTokens ?? 0) + (u2.cacheReadTokens ?? 0),
    cacheWriteTokens: (u1.cacheWriteTokens ?? 0) + (u2.cacheWriteTokens ?? 0),
  };
}

/**
 * Splits reviewable files into batches by diff size so each batch stays within
 * model context and answer token limits.
 * Guarantees that if files.length >= 2, at least 2 batches are returned. Without a cap it
 * splits in halves: used only by truncation recovery, after a whole-PR call that fit
 * `review.maxPromptTokens`. A PR above that size goes through `batchFilesByTokenCap`.
 */
export function batchFilesBySize(
  files: readonly ReviewableFileWithPatch[],
  maxBatchTokens?: number,
): ReviewableFileWithPatch[][] {
  if (files.length <= 1) return [files.map((f) => ({ ...f }))];

  const fileTokens = files.map((f) => ({ file: f, tokens: estimateTokens(f.patch) }));
  const totalTokens = fileTokens.reduce((sum, item) => sum + item.tokens, 0);
  const targetBatchTokens = maxBatchTokens ?? Math.max(100, Math.floor(totalTokens / 2));

  const batches: ReviewableFileWithPatch[][] = [];
  let currentBatch: ReviewableFileWithPatch[] = [];
  let currentTokens = 0;

  for (const item of fileTokens) {
    if (currentBatch.length > 0 && currentTokens + item.tokens > targetBatchTokens) {
      batches.push(currentBatch);
      currentBatch = [{ ...item.file }];
      currentTokens = item.tokens;
    } else {
      currentBatch.push({ ...item.file });
      currentTokens += item.tokens;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Ensure at least 2 batches if files.length >= 2
  if (batches.length === 1 && files.length >= 2) {
    const mid = Math.ceil(files.length / 2);
    return [
      files.slice(0, mid).map((f) => ({ ...f })),
      files.slice(mid).map((f) => ({ ...f })),
    ];
  }

  return batches;
}

/**
 * Deduplicates findings across batches by path, line, and normalized title.
 * Re-numbers finding IDs sequentially (f1, f2, ...).
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  let idCounter = 1;

  for (const f of findings) {
    const key = `${f.path}:${f.line}:${f.title.toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({
        ...f,
        id: `f${idCounter++}`,
      });
    }
  }

  return result;
}

export const reviewJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(ReviewAnswerSchema) as Record<string, unknown>;

/** A parse failure worth a bigger-output retry: the answer was cut off, not merely wrong. */
export function needsTruncationRetry(
  parsed: { ok: true } | { ok: false; code: string },
  finishReason: string | undefined,
): boolean {
  return !parsed.ok && (parsed.code === 'truncated' || finishReason === 'max-tokens');
}

/** Appended to a patch cut to fit one batch, so the model knows the rest was not shown. */
export const PATCH_TRUNCATED_NOTE = '[patch truncated: the rest of this file was not sent for review]';

/**
 * Cuts a patch to about `capTokens` (at a line break) and appends PATCH_TRUNCATED_NOTE. Only the
 * truncation-recovery retry (ADR-0013) cuts a patch: a file too big for one batch is split into
 * parts instead (ADR-0045).
 */
export function truncatePatch(patch: string, capTokens: number): string {
  const maxChars = Math.max(0, Math.floor(capTokens * 3.5) - PATCH_TRUNCATED_NOTE.length - 1);
  let cut = patch.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > 0) cut = cut.slice(0, lastBreak);
  return `${cut}\n${PATCH_TRUNCATED_NOTE}`;
}

export interface CappedBatches {
  batches: ReviewableFileWithPatch[][];
  /** Files whose patch was split into more parts than `maxFileParts`: the parts left out. */
  skippedParts: Array<{ path: string; from: number; total: number }>;
  /** Files with a line too big for the cap: the line was cut to fit `review.batchTokens`. */
  cutLines: Array<{ path: string; count: number }>;
}

/**
 * Splits files into batches of at most `capTokens` diff tokens each (ADR-0013), grouped and
 * ordered by `groupFilesForBatches` (ADR-0031): a group that fits the cap shares one batch; a
 * bigger group is split between implementations, then between files. A single file bigger than
 * the cap is split into parts of at most the cap, one part per batch (ADR-0045); the parts beyond
 * `maxFileParts` are not sent and are reported as skipped. A line too big for the cap on its own
 * is cut to fit, and the file says how many lines were cut.
 */
export function batchFilesByTokenCap(
  files: readonly ReviewableFileWithPatch[],
  capTokens: number,
  maxFileParts = 8,
): CappedBatches {
  const batches: ReviewableFileWithPatch[][] = [];
  const skippedParts: Array<{ path: string; from: number; total: number }> = [];
  const cutLines: Array<{ path: string; count: number }> = [];
  let current: ReviewableFileWithPatch[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
    currentTokens = 0;
  };
  // Test-only units split out of an oversized source group wait until every source group is
  // placed, so a big directory never puts its tests ahead of another directory's source.
  const deferredTests: BatchNode<ReviewableFileWithPatch>[] = [];
  const placeDeferred = (): void => {
    deferredTests.splice(0).forEach(place);
  };
  const place = (node: BatchNode<ReviewableFileWithPatch>): void => {
    if (node.tokens <= capTokens) {
      if (currentTokens + node.tokens > capTokens) flush();
      current.push(...node.files.map((f) => ({ ...f })));
      currentTokens += node.tokens;
    } else if (node.children) {
      for (const child of node.children) {
        if (node.tier === FileTier.Source && child.tier !== FileTier.Source) deferredTests.push(child);
        else place(child);
      }
    } else {
      const file = node.files[0]!;
      flush();
      const split = splitPatchIntoParts(file.patch, capTokens);
      split.parts.slice(0, maxFileParts).forEach((part, index) => {
        batches.push([{ path: file.path, patch: part, part: { index: index + 1, total: split.parts.length } }]);
      });
      if (split.parts.length > maxFileParts) {
        skippedParts.push({ path: file.path, from: maxFileParts + 1, total: split.parts.length });
      }
      if (split.cutLines > 0) {
        cutLines.push({ path: file.path, count: split.cutLines });
      }
    }
  };

  for (const group of groupFilesForBatches(files, (f) => estimateTokens(f.patch))) {
    if (group.tier !== FileTier.Source) placeDeferred();
    place(group);
  }
  placeDeferred();
  flush();
  return { batches, skippedParts, cutLines };
}
