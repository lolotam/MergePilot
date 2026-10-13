import { z } from 'zod';
import {
  MAX_REPO_COLORS,
  type RepoColorKey,
  REPO_COLOR_KEYS,
  RUN_RETENTION_CHOICES,
} from '../core/run-types.js';

// Run retention, bulk delete and repository colors (ADR-0014). Re-exported by contract.ts.

export { MAX_REPO_COLORS, REPO_COLOR_KEYS, RUN_RETENTION_CHOICES, type RepoColorKey };

/** Settings field: 30 / 90 / 180 / 365 days, or null = keep forever. */
export const RunRetentionDaysSchema = z.literal([...RUN_RETENTION_CHOICES]).nullable();

export const RepoColorKeySchema = z.enum(REPO_COLOR_KEYS);

/** `owner/repo` as GitHub names it (owner: letters, digits, hyphens; repo also `.` and `_`). */
export const RepoFullNameSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/, 'Invalid repository name');

/** Settings field: chosen palette key per repository; repos left out use the default color. */
export const RepoColorsSchema = z
  .record(RepoFullNameSchema, RepoColorKeySchema)
  .refine((colors) => Object.keys(colors).length <= MAX_REPO_COLORS, {
    message: `At most ${MAX_REPO_COLORS} repository colors`,
  });
export type RepoColors = z.infer<typeof RepoColorsSchema>;

export const MAX_DELETE_IDS = 500;

/** The runs page filters, with the same meaning as the list query. */
export const DeleteRunsFiltersSchema = z.object({
  repo: z.array(z.string().min(1).max(200)).max(50).optional(),
  status: z.array(z.enum(['queued', 'running', 'completed', 'skipped', 'failed'])).max(5).optional(),
  from: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  to: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
  q: z.string().max(200).optional(),
});
export type DeleteRunsFilters = z.infer<typeof DeleteRunsFiltersSchema>;

/**
 * POST (admin/owner) /api/workspaces/:workspaceId/runs/delete -> 200 { deleted }.
 * Either up to 500 run ids (all must be runs of this workspace, else 404), or the list filters
 * plus `confirmCount`, which must equal the number of runs the filters match now (else 409 with
 * `actual`). Queued and running runs are never deleted, so `deleted` may be lower.
 */
export const DeleteRunsRequestSchema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(MAX_DELETE_IDS) }).strict(),
  z.object({ filters: DeleteRunsFiltersSchema, confirmCount: z.number().int().min(0) }).strict(),
]);
export type DeleteRunsRequest = z.infer<typeof DeleteRunsRequestSchema>;

export const DeleteRunsResponseSchema = z.object({ deleted: z.number().int() });
export type DeleteRunsResponse = z.infer<typeof DeleteRunsResponseSchema>;

export const MaintenanceRunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  deletedCount: z.number().int(),
  error: z.string().nullable(),
});
export type MaintenanceRunDto = z.infer<typeof MaintenanceRunSchema>;

/** GET (platform admin) /api/admin/maintenance */
export const AdminMaintenanceResponseSchema = z.object({
  retention: z.object({ lastRun: MaintenanceRunSchema.nullable() }),
  /** The model price refresh (ADR-0016); `deletedCount` is the number of prices stored. */
  prices: z.object({ lastRun: MaintenanceRunSchema.nullable() }).optional(),
});
export type AdminMaintenanceResponse = z.infer<typeof AdminMaintenanceResponseSchema>;

/** POST (platform admin) /api/admin/maintenance/run-retention -> 202 { runId }; 409 when one is running. */
export const RunRetentionResponseSchema = z.object({ runId: z.string() });
export type RunRetentionResponse = z.infer<typeof RunRetentionResponseSchema>;
/** POST (platform admin) /api/admin/maintenance/refresh-prices -> 202 { runId }; 409 when one is running. */
export const RefreshPricesResponseSchema = RunRetentionResponseSchema;
