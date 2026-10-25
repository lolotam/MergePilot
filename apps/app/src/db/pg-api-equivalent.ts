import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { ApiEquivalentRunRow, ApiEquivalentRunUsage, ReviewRunStatus } from '../core/types.js';
import type { AppDb } from './pg-store.js';
import { reviewRuns } from './schema.js';

/**
 * Reads only; the card never backfills or changes run rows. Only the runs the card can count, and
 * only the judge's two token counts, not its whole record.
 */
export async function listPgApiEquivalentRuns(
  db: AppDb,
  workspaceId: string,
  providers: readonly string[],
): Promise<ApiEquivalentRunRow[]> {
  const pricing = sql`${reviewRuns.result}->'pricing'`;
  const rows = await db
    .select({
      createdAt: reviewRuns.createdAt,
      status: reviewRuns.status,
      provider: reviewRuns.provider,
      model: reviewRuns.model,
      pricing: sql<unknown>`${pricing}`,
      usage: sql<ApiEquivalentRunUsage | null>`${reviewRuns.result}->'usage'`,
      judgeInput: sql<number | null>`(${reviewRuns.result}->'judge'->>'inputTokens')::float8`,
      judgeOutput: sql<number | null>`(${reviewRuns.result}->'judge'->>'outputTokens')::float8`,
      fallbackFromMethod: sql<string | null>`${reviewRuns.result}->>'fallbackFromMethod'`,
    })
    .from(reviewRuns)
    .where(and(
      eq(reviewRuns.workspaceId, workspaceId),
      isNotNull(reviewRuns.result),
      or(
        inArray(reviewRuns.provider, [...providers]),
        sql`${pricing}->'apiEquivalentUsd' is not null`,
        sql`${pricing}->'subscriptionPart' is not null`,
      ),
    ));
  return rows.map((row) => ({
    createdAt: new Date(row.createdAt),
    status: row.status as ReviewRunStatus,
    provider: row.provider,
    model: row.model,
    pricing: row.pricing,
    usage: row.usage,
    judgeUsage: row.judgeInput !== null && row.judgeOutput !== null
      ? { inputTokens: row.judgeInput, outputTokens: row.judgeOutput }
      : null,
    fallbackFromMethod: row.fallbackFromMethod,
  }));
}
