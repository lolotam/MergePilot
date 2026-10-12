import { runTokens, type ReviewRunGroup } from '../core/run-types.js';
import type { ReviewRun } from '../core/types.js';
import { computeSeverityCounts, type ReviewRun as ReviewRunDto, type RunGroup } from './contract.js';

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** A run as the runs list returns it (no result payload; tokens and severity counts from it). */
export function toRunDto(r: ReviewRun): ReviewRunDto {
  const tokens = runTokens(r);
  return {
    id: r.id,
    repoFullName: r.repoFullName,
    pullNumber: r.pullNumber,
    headSha: r.headSha,
    status: r.status,
    costUsd: r.costUsd,
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
  };
}

export function toRunGroupDto(g: ReviewRunGroup): RunGroup {
  return {
    repoFullName: g.repoFullName,
    pullNumber: g.pullNumber,
    runCount: g.runCount,
    costUsd: g.costUsd,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    runs: g.runs.map(toRunDto),
  };
}
