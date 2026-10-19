import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { DEFAULT_JUDGE_THRESHOLD, isJudgeUse, legacyJudgeMode, normalizeJudgeUses } from '@mergepilot/engine';
import { BotNameTakenError, type SaveSettingsOptions, sameBotName, SettingsChangedError, UnknownSkillError } from '../core/types.js';
import type {
  ApiProvider,
  BotLogo,
  JudgeSettings,
  MaxFindingsChoice,
  PanelMode,
  PriceOverride,
  WorkspaceSettings,
} from '../core/types.js';
import { DEFAULT_RUN_RETENTION_DAYS } from '../core/run-types.js';
import type { AppDb } from './pg-store.js';
import { isConstraintViolation, SKILL_FOREIGN_KEYS, SKILL_ID_PATTERN } from './pg-skills.js';
import { reviewerBots, workspaceSettings } from './schema.js';
import { lockBotNames, lockSettings, withLiveWorkspace, type AppTx } from './workspace-lock.js';

export async function getPgSettings(db: AppDb | AppTx, workspaceId: string): Promise<WorkspaceSettings | null> {
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
    maxFindings: row.maxFindings as MaxFindingsChoice,
    perReviewUsd: Number(row.perReviewUsd),
    runRetentionDays: row.runRetentionDays !== null ? Number(row.runRetentionDays) : null,
    repoColors: (row.repoColors ?? {}) as WorkspaceSettings['repoColors'],
    judge: row.judgeProvider
      ? {
          enabled: row.judgeEnabled,
          provider: row.judgeProvider as JudgeSettings['provider'],
          model: row.judgeModel ?? '',
          uses: normalizeJudgeUses((row.judgeUses ?? []).filter(isJudgeUse)),
          threshold: Number(row.judgeThreshold),
          fallback: Array.isArray(row.judgeFallback) ? (row.judgeFallback as JudgeSettings['fallback']) : [],
        }
      : null,
    priceOverrides: Array.isArray(row.priceOverrides) ? (row.priceOverrides as PriceOverride[]) : [],
    botName: row.botName,
    botLogo: row.botLogo as BotLogo,
    panelMode: row.panelMode as PanelMode,
    panelMinAgreement: Number(row.panelMinAgreement),
    ...skillFields(row),
  };
}

/** The skill fields of a settings or bot row, left out while unset (ADR-0034). */
export function skillFields(row: { skillId: string | null; skillRemovedName: string | null }): Pick<WorkspaceSettings, 'skillId' | 'skillRemovedName'> {
  return {
    ...(row.skillId ? { skillId: row.skillId } : {}),
    ...(row.skillRemovedName ? { skillRemovedName: row.skillRemovedName } : {}),
  };
}

/**
 * The judge columns for a save: null clears them back to the defaults (off). `judge_mode` is no
 * longer read; it gets the closest old mode so a rollback within one release still works.
 */
function judgeColumns(judge: JudgeSettings | null): Partial<typeof workspaceSettings.$inferInsert> {
  return {
    judgeEnabled: judge?.enabled ?? false,
    judgeProvider: judge?.provider ?? null,
    judgeModel: judge?.model ?? null,
    judgeUses: judge ? normalizeJudgeUses(judge.uses) : [],
    judgeMode: judge ? legacyJudgeMode(judge.uses) : 'off',
    judgeThreshold: String(judge?.threshold ?? DEFAULT_JUDGE_THRESHOLD),
    judgeFallback: judge?.fallback ?? [],
  };
}

/**
 * Upserts the settings. `maxFindings`, `runRetentionDays`, `repoColors`, `judge`, `priceOverrides`
 * and the panel fields (`botName`, `botLogo`, `panelMode`, `panelMinAgreement`) left undefined keep
 * the stored value (a new row gets the column defaults: 5 findings, 30 days, no colors, no manual
 * prices, the "MergePilot" bot, separate reviews).
 * `skillId` left undefined keeps the stored skill; any value (null = Default) clears the
 * deleted-skill note (ADR-0034).
 * Throws BotNameTakenError when `botName` matches an extra bot's name, and UnknownSkillError when
 * `skillId` is not a skill of this workspace.
 */
export async function savePgSettings(db: AppDb, settings: WorkspaceSettings, options?: SaveSettingsOptions): Promise<void> {
  // A skill id that is not a uuid names no skill (and would be a Postgres type error).
  if (settings.skillId != null && !SKILL_ID_PATTERN.test(settings.skillId)) throw new UnknownSkillError(settings.skillId);
  try {
    await withLiveWorkspace(db, settings.workspaceId, (tx) => writePgSettings(tx, settings, options));
  } catch (error) {
    if (settings.skillId && isConstraintViolation(error, '23503', SKILL_FOREIGN_KEYS)) throw new UnknownSkillError(settings.skillId);
    throw error;
  }
}

/** The body of savePgSettings, inside the caller's live-workspace transaction (also used by a restore). */
export async function writePgSettings(tx: AppTx, settings: WorkspaceSettings, options?: SaveSettingsOptions): Promise<void> {
  await lockSettings(tx, settings.workspaceId);
  if (options?.expected !== undefined && !isDeepStrictEqual(await getPgSettings(tx, settings.workspaceId), options.expected)) {
    throw new SettingsChangedError(settings.workspaceId);
  }
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
  if (settings.perReviewUsd !== undefined) values.perReviewUsd = String(settings.perReviewUsd);
  if (settings.maxFindings !== undefined) values.maxFindings = settings.maxFindings;
  if (settings.runRetentionDays !== undefined) values.runRetentionDays = settings.runRetentionDays;
  if (settings.repoColors !== undefined) values.repoColors = settings.repoColors;
  if (settings.judge !== undefined) Object.assign(values, judgeColumns(settings.judge));
  if (settings.priceOverrides !== undefined) values.priceOverrides = settings.priceOverrides;
  if (settings.botName !== undefined) values.botName = settings.botName;
  if (settings.botLogo !== undefined) values.botLogo = settings.botLogo;
  if (settings.panelMode !== undefined) values.panelMode = settings.panelMode;
  if (settings.panelMinAgreement !== undefined) values.panelMinAgreement = settings.panelMinAgreement;
  if (settings.skillId !== undefined) {
    // The bot-name lock before the row, like deleting a skill (pg-skills.ts), so the two cannot deadlock.
    await lockBotNames(tx, settings.workspaceId);
    values.skillId = settings.skillId;
    values.skillRemovedName = null;
  }
  const botName = settings.botName;
  if (botName !== undefined) {
    // A renamed main bot must differ from every extra bot's name, checked under the bot-name lock.
    // An unchanged name is not re-checked, so saving other settings is never blocked by it.
    await lockBotNames(tx, settings.workspaceId);
    const stored = await tx
      .select({ name: workspaceSettings.botName })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, settings.workspaceId));
    const renamed = !stored[0] || !sameBotName(stored[0].name, botName);
    const extras = !renamed ? [] : await tx
      .select({ name: reviewerBots.name })
      .from(reviewerBots)
      .where(eq(reviewerBots.workspaceId, settings.workspaceId));
    if (extras.some((bot) => sameBotName(bot.name, botName))) throw new BotNameTakenError(botName);
  }
  await tx
    .insert(workspaceSettings)
    .values({
      workspaceId: settings.workspaceId,
      runRetentionDays: DEFAULT_RUN_RETENTION_DAYS,
      ...values,
    })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: values });
}
