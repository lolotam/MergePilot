import {
  describeAnsweredBy,
  type Judge,
  type JudgeFilterSummary,
  type JudgeMode,
  type JudgeReport,
  type TokenUsage,
} from '@mergepilot/engine';

/** The Jev judge as a shell hands it to a review (ADR-0015). */
export interface ReviewJudge {
  judge: Judge;
  mode: JudgeMode;
  threshold: number;
}

/** What the summary discloses about the judge. */
export interface JudgeSummaryInput {
  /** "provider:model (fallback n; … failed: code)" of the entry that answered. */
  answeredBy?: string | undefined;
  /** Code of the false-positive filter request on which every entry failed (published unfiltered). */
  unavailable?: string | undefined;
  /** Code when only the semantic duplicate check failed (the filter itself ran or was off). */
  duplicatesUnavailable?: string | undefined;
  filtered?: ReadonlyArray<{ title: string; path: string; line: number; noul: number }> | undefined;
}

export function judgeSummaryInput(
  report: JudgeReport | undefined,
  filter: JudgeFilterSummary | undefined,
): JudgeSummaryInput | undefined {
  if (!report || report.attempts.length === 0) return undefined;
  const unavailable = filter?.unavailable;
  // A report-level failure the filter did not have came from the later duplicate check.
  const duplicatesUnavailable = !unavailable ? report.unavailable : undefined;
  return {
    ...(report.answeredBy ? { answeredBy: describeAnsweredBy(report.answeredBy) } : {}),
    ...(unavailable ? { unavailable } : {}),
    ...(duplicatesUnavailable ? { duplicatesUnavailable } : {}),
    ...(filter && filter.filtered.length > 0 ? { filtered: filter.filtered } : {}),
  };
}

/**
 * The review's cost and tokens with every billed judge attempt added. A judge cost counts only
 * when known (Vercel reports it, a priced Jev model has it); unknown stays unknown.
 */
export function withJudgeUsage(
  costUsd: number | undefined,
  usage: TokenUsage | undefined,
  report: JudgeReport | undefined,
): { costUsd?: number | undefined; inputTokens?: number | undefined; outputTokens?: number | undefined } {
  const judgeIn = report?.inputTokens ?? 0;
  const judgeOut = report?.outputTokens ?? 0;
  const hasTokens = usage !== undefined || judgeIn + judgeOut > 0;
  const cost = costUsd === undefined && report?.costUsd === undefined ? undefined : (costUsd ?? 0) + (report?.costUsd ?? 0);
  return {
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(hasTokens
      ? { inputTokens: (usage?.inputTokens ?? 0) + judgeIn, outputTokens: (usage?.outputTokens ?? 0) + judgeOut }
      : {}),
  };
}
