import {
  createJudge,
  describeAnsweredBy,
  type FetchLike,
  type JudgeEntry,
  type JudgeFilterSummary,
  type JudgePriceLookup,
  type JudgeReport,
  type KeyRotationEvent,
  type Secret,
  type TokenUsage,
} from '@mergepilot/engine';
import type { ReviewJudge, SemanticDedupeResult } from '@mergepilot/github';
import type { Logger } from 'pino';
import type { ReviewRunJudge, WorkspaceSettings } from '../core/types.js';
import { isMultiKeyProvider } from '../credentials/multi-key.js';
import type { ProcessReviewCredentials } from './types.js';

export interface WorkspaceJudge {
  judge?: ReviewJudge | undefined;
  /** The judge keys, redacted like every other key. */
  secrets: Secret[];
}

/**
 * The workspace's Jev judge (ADR-0015): its provider plus up to three explicit fallbacks, each
 * with the workspace key for that provider. An entry without a readable key stays in the chain
 * without a key, so the judge skips it and discloses "no-key". One `judge.call` log line per
 * attempt: provider, model, counts, timing and tokens, never the state.
 *
 * A disabled judge is absent whatever its uses; an enabled one with no uses is created but makes
 * no request (the review and the duplicate check each look at `uses`).
 */
export async function workspaceJudge(
  settings: WorkspaceSettings,
  workspaceId: string,
  credentials: ProcessReviewCredentials,
  logger: Logger,
  context: {
    jobId: string;
    runId: string;
    fetch?: FetchLike | undefined;
    priceLookup?: JudgePriceLookup | undefined;
    onKeyRotation?: ((event: KeyRotationEvent) => void) | undefined;
    rosterKeyIds?: Record<string, string[]> | undefined;
  },
): Promise<WorkspaceJudge> {
  const config = settings.judge;
  if (!config?.enabled) return { secrets: [] };
  const secrets: Secret[] = [];
  const entries: JudgeEntry[] = [];
  for (const entry of [{ provider: config.provider, model: config.model }, ...config.fallback]) {
    try {
      if (credentials.resolveKeyRoster && isMultiKeyProvider(entry.provider)) {
        const roster = await credentials.resolveKeyRoster(workspaceId, entry.provider);
        if (roster && roster.secrets.length > 0) {
          if (context.rosterKeyIds) context.rosterKeyIds[entry.provider] = roster.keyIds;
          secrets.push(...roster.secrets);
          const start = roster.startIndex >= 0 && roster.startIndex < roster.secrets.length ? roster.startIndex : 0;
          const apiKey = roster.secrets[start];
          entries.push({
            ...entry,
            ...(apiKey ? { apiKey } : {}),
            keys: roster.secrets,
            startIndex: start,
            ...(context.onKeyRotation ? { onKeyRotation: context.onKeyRotation } : {}),
          });
          continue;
        }
      }
      const apiKey = await credentials.resolve(workspaceId, entry.provider);
      secrets.push(apiKey);
      entries.push({ ...entry, apiKey });
    } catch {
      entries.push(entry);
    }
  }
  const judge = createJudge({
    entries,
    ...(context.fetch ? { fetch: context.fetch } : {}),
    // Catalog and workspace prices first (ADR-0016); the static Jev table stays the last resort.
    ...(context.priceLookup ? { priceLookup: context.priceLookup } : {}),
    onCall: (event) =>
      logger.info(
        {
          event: 'judge.call',
          jobId: context.jobId,
          runId: context.runId,
          provider: event.provider,
          model: event.model,
          fallback: event.fallbackIndex,
          questions: event.questions,
          ms: event.ms,
          ok: event.ok,
          code: event.code ?? null,
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
        },
        `Jev judge call to ${event.provider}:${event.model} ${event.ok ? 'answered' : `failed (${event.code ?? 'error'})`}`,
      ),
  });
  return { judge: { judge, uses: [...config.uses], threshold: config.threshold }, secrets };
}

/** `result.judge` for the run record: what the judge did, every attempt, its tokens and cost. */
export function judgeRunRecord(
  judge: ReviewJudge,
  report: JudgeReport,
  filter: JudgeFilterSummary | undefined,
  semantic: SemanticDedupeResult | undefined,
): ReviewRunJudge {
  const unavailable = filter?.unavailable ?? semantic?.unavailable ?? report.unavailable;
  return {
    uses: [...judge.uses],
    threshold: judge.threshold,
    checked: filter?.checked ?? 0,
    filtered: filter?.filtered ?? [],
    duplicatesDropped: semantic?.dropped ?? 0,
    ...(report.answeredBy ? { answeredBy: describeAnsweredBy(report.answeredBy) } : {}),
    ...(unavailable ? { unavailable } : {}),
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
    attempts: report.attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      ok: a.ok,
      ...(a.code ? { code: a.code } : {}),
      ms: a.ms,
      ...(a.skipped ? { skipped: true } : {}),
    })),
  };
}

/**
 * The judge's part of a finished run: its record, the run usage with every billed judge attempt
 * added (so the monthly usage counts it), and a run-detail note when the judge was unavailable.
 */
export function judgeRunParts(
  setup: WorkspaceJudge,
  usage: TokenUsage | undefined,
  filter: JudgeFilterSummary | undefined,
  semantic: SemanticDedupeResult | undefined,
): { judge?: ReviewRunJudge | undefined; usage: TokenUsage | undefined; note?: string | undefined } {
  const report = setup.judge?.judge.report();
  if (!setup.judge || !report || report.attempts.length === 0) return { usage };
  const record = judgeRunRecord(setup.judge, report, filter, semantic);
  const base = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  return {
    judge: record,
    usage: { ...base, inputTokens: base.inputTokens + report.inputTokens, outputTokens: base.outputTokens + report.outputTokens },
    ...(record.unavailable ? { note: `Jev judge unavailable: ${record.unavailable}` } : {}),
  };
}
