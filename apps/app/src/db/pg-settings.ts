import { eq } from 'drizzle-orm';
import type { ApiProvider, JudgeSettings, PriceOverride, WorkspaceSettings } from '../core/types.js';
import { DEFAULT_RUN_RETENTION_DAYS } from '../core/run-types.js';
import type { AppDb } from './pg-store.js';
import { workspaceSettings } from './schema.js';
import { withLiveWorkspace } from './workspace-lock.js';

export async function getPgSettings(db: AppDb, workspaceId: string): Promise<WorkspaceSettings | null> {
  const rows = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspaceId,
    provider: row.provider as ApiProvider,
    model: row.model,
    language: row.language as 'ar' | 'en',
    monthlyBudgetUsd: row.monthlyBudgetUsd !== null ? Number(row.monthlyBudgetUsd) : null,
    effort: row.effort ?? null,
    heavyProvider: (row.heavyProvider as ApiProvider) ?? null,
    heavyModel: row.heavyModel ?? null,
    heavyEffort: row.heavyEffort ?? null,
    heavyThresholdLines: row.heavyThresholdLines !== null ? Number(row.heavyThresholdLines) : 800,
    fallback: Array.isArray(row.fallback) ? (row.fallback as WorkspaceSettings['fallback']) : [],
    minSeverity: (row.minSeverity as WorkspaceSettings['minSeverity']) ?? 'medium',
    runRetentionDays: row.runRetentionDays !== null ? Number(row.runRetentionDays) : null,
    repoColors: (row.repoColors ?? {}) as WorkspaceSettings['repoColors'],
    judge: row.judgeProvider
      ? {
          enabled: row.judgeEnabled,
          provider: row.judgeProvider as JudgeSettings['provider'],
          model: row.judgeModel ?? '',
          mode: row.judgeMode as JudgeSettings['mode'],
          threshold: Number(row.judgeThreshold),
          fallback: Array.isArray(row.judgeFallback) ? (row.judgeFallback as JudgeSettings['fallback']) : [],
        }
      : null,
    priceOverrides: Array.isArray(row.priceOverrides) ? (row.priceOverrides as PriceOverride[]) : [],
  };
}

/** The judge columns for a save: null clears them back to the defaults (off). */
function judgeColumns(judge: JudgeSettings | null): Partial<typeof workspaceSettings.$inferInsert> {
  return {
    judgeEnabled: judge?.enabled ?? false,
    judgeProvider: judge?.provider ?? null,
    judgeModel: judge?.model ?? null,
    judgeMode: judge?.mode ?? 'off',
    judgeThreshold: String(judge?.threshold ?? 0.35),
    judgeFallback: judge?.fallback ?? [],
  };
}

/**
 * Upserts the settings. `runRetentionDays`, `repoColors`, `judge` and `priceOverrides` left undefined keep the stored value
 * (a new row gets the column defaults: 30 days, no colors).
 */
export async function savePgSettings(db: AppDb, settings: WorkspaceSettings): Promise<void> {
  const budgetStr = settings.monthlyBudgetUsd !== null && settings.monthlyBudgetUsd !== undefined
    ? String(settings.monthlyBudgetUsd) : null;
  const values: Partial<typeof workspaceSettings.$inferInsert> & Pick<typeof workspaceSettings.$inferInsert, 'provider' | 'model' | 'language'> = {
    provider: settings.provider,
    model: settings.model,
    language: settings.language,
    monthlyBudgetUsd: budgetStr,
    effort: settings.effort ?? null,
    heavyProvider: settings.heavyProvider ?? null,
    heavyModel: settings.heavyModel ?? null,
    heavyEffort: settings.heavyEffort ?? null,
    heavyThresholdLines: settings.heavyThresholdLines ?? 800,
    fallback: settings.fallback ?? [],
    minSeverity: settings.minSeverity ?? 'medium',
    updatedAt: new Date(),
  };
  if (settings.runRetentionDays !== undefined) values.runRetentionDays = settings.runRetentionDays;
  if (settings.repoColors !== undefined) values.repoColors = settings.repoColors;
  if (settings.judge !== undefined) Object.assign(values, judgeColumns(settings.judge));
  if (settings.priceOverrides !== undefined) values.priceOverrides = settings.priceOverrides;
  await withLiveWorkspace(db, settings.workspaceId, async (tx) => {
    await tx
      .insert(workspaceSettings)
      .values({
        workspaceId: settings.workspaceId,
        runRetentionDays: DEFAULT_RUN_RETENTION_DAYS,
        ...values,
      })
      .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: values });
  });
}
