import { runDurationMs, runTokens, type ReviewRunGroup } from '../core/run-types.js';
import type { ReviewRun } from '../core/types.js';
import { computeSeverityCounts, type ReviewRun as ReviewRunDto, type RunGroup } from './contract.js';

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Like the store's group sums: null when no run has a value. */
const sumOrNull = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

const apiEquivalentOf = (r: ReviewRun): number | null => r.result?.pricing?.apiEquivalentUsd ?? null;

/** A run as the runs list returns it (no result payload; tokens, severity counts and duration from it). */
export function toRunDto(r: ReviewRun): ReviewRunDto {
  const tokens = runTokens(r);
  return {
    id: r.id,
    repoFullName: r.repoFullName,
    pullNumber: r.pullNumber,
    headSha: r.headSha,
    status: r.status,
    costUsd: r.costUsd,
    apiEquivalentUsd: apiEquivalentOf(r),
    detail: r.detail,
    createdAt: iso(r.createdAt),
    finishedAt: r.finishedAt ? iso(r.finishedAt) : null,
    provider: r.provider ?? null,
    model: r.model ?? null,
    effort: r.effort ?? null,
    fallbackFrom: r.fallbackFrom ?? null,
    findingsCount: r.findingsCount ?? null,
    severityCounts: r.result ? computeSeverityCounts(r.result.findings, r.result.outOfDiff) : null,
    reviewUrl: r.reviewUrl ?? null,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    durationMs: runDurationMs(r),
    botSlot: r.botSlot ?? 1,
    botName: r.botName ?? null,
  };
}

export function toRunGroupDto(g: ReviewRunGroup): RunGroup {
  return {
    repoFullName: g.repoFullName,
    pullNumber: g.pullNumber,
    runCount: g.runCount,
    costUsd: g.costUsd,
    apiEquivalentUsd: sumOrNull(g.runs.map(apiEquivalentOf)),
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    runs: g.runs.map(toRunDto),
  };
}
