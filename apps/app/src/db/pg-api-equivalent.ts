import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { ApiEquivalentRunRow, ApiEquivalentRunUsage, ReviewRunJudge } from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { reviewRuns } from './schema.js';

function judgeUsage(judge: ReviewRunJudge | undefined): ApiEquivalentRunUsage | null {
  return judge ? { inputTokens: judge.inputTokens, outputTokens: judge.outputTokens } : null;
}

/** Reads only; the card never backfills or changes run rows. */
export async function listPgApiEquivalentRuns(db: AppDb, workspaceId: string): Promise<ApiEquivalentRunRow[]> {
  const rows = await db
    .select({
      createdAt: reviewRuns.createdAt,
      provider: reviewRuns.provider,
      model: reviewRuns.model,
      pricing: sql<unknown>`${reviewRuns.result}->'pricing'`,
      usage: sql<ApiEquivalentRunUsage | null>`${reviewRuns.result}->'usage'`,
      judge: sql<ReviewRunJudge | null>`${reviewRuns.result}->'judge'`,
    })
    .from(reviewRuns)
    .where(and(eq(reviewRuns.workspaceId, workspaceId), isNotNull(reviewRuns.result)));
  return rows.map((row) => ({
    createdAt: new Date(row.createdAt),
    provider: row.provider,
    model: row.model,
    pricing: row.pricing,
    usage: row.usage,
    judgeUsage: judgeUsage(row.judge ?? undefined),
  }));
}
