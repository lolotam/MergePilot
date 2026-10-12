import { z } from 'zod';

/**
 * Dashboard REST contract (wave F). The API routes (apps/app/src/api) and the web UI
 * (apps/web) both build against these shapes. Auth itself (sign-in, sessions, workspace
 * creation, invitations, members) is Better Auth's own `/api/auth/*` endpoints.
 *
 * Every route below requires a signed-in session. Workspace routes take
 * `:workspaceId` and enforce the role noted next to them (ADR-0007).
 */

import { API_PROVIDER_IDS, SeveritySchema } from '@mergepilot/engine';
import { RepoColorsSchema, RunRetentionDaysSchema } from './contract-runs.js';

export * from './contract-runs.js';

export const ApiProviderSchema = z.enum(API_PROVIDER_IDS);
export type ApiProvider = z.infer<typeof ApiProviderSchema>;
export type Severity = z.infer<typeof SeveritySchema>;

export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** GET /api/me — signed in. */
export const MeResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    githubLinked: z.boolean(),
  }),
  workspaces: z.array(
    z.object({ id: z.string(), name: z.string(), slug: z.string(), role: z.enum(['owner', 'admin', 'member']) }),
  ),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** A thinking effort as providers name it (off / on / minimal / low / medium / high / xhigh / max ...). */
export const EffortSchema = z.string().regex(/^[a-z0-9_-]{1,24}$/, 'Invalid effort');
const ModelIdSchema = z.string().trim().min(1).max(200);

export const MAX_FALLBACK_MODELS = 3;

export const FallbackEntrySchema = z.object({
  provider: ApiProviderSchema,
  model: ModelIdSchema,
  effort: EffortSchema.nullable().optional(),
});
export type FallbackEntry = z.infer<typeof FallbackEntrySchema>;

/** GET (member) / PUT (admin) /api/workspaces/:workspaceId/settings */
export const SettingsSchema = z.object({
  provider: ApiProviderSchema,
  model: ModelIdSchema,
  language: z.enum(['ar', 'en']),
  monthlyBudgetUsd: z.number().positive().nullable().optional(),
  effort: EffortSchema.nullable().optional(),
  heavyProvider: ApiProviderSchema.nullable().optional(),
  heavyModel: ModelIdSchema.nullable().optional(),
  heavyEffort: EffortSchema.nullable().optional(),
  /** Changed lines (additions + deletions) from which the heavy model reviews the PR. */
  heavyThresholdLines: z.number().int().positive().max(1_000_000).nullable().optional(),
  fallback: z.array(FallbackEntrySchema).max(MAX_FALLBACK_MODELS).optional().default([]),
  minSeverity: SeveritySchema.optional().default('medium'),
  /** Days to keep review runs; null = forever. Left out on PUT keeps the stored value (30 by default). */
  runRetentionDays: RunRetentionDaysSchema.optional(),
  /** `owner/repo` -> palette key for the runs table; left out on PUT keeps the stored map. */
  repoColors: RepoColorsSchema.optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * PUT body: provider, model and language are required; every other field is a patch. Left out
 * (undefined) keeps the stored value, so an older client that only sends the budget does not
 * wipe the J2 fields; an explicit `null` clears it (fallback → [], minSeverity → medium).
 */
export const SettingsUpdateSchema = SettingsSchema.extend({
  fallback: z.array(FallbackEntrySchema).max(MAX_FALLBACK_MODELS).nullable().optional(),
  minSeverity: SeveritySchema.nullable().optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
export const SettingsResponseSchema = z.object({ settings: SettingsSchema.nullable() });

/** GET (admin) /api/workspaces/:workspaceId/keys */
export const KeysResponseSchema = z.object({
  keys: z.array(
    z.object({
      provider: ApiProviderSchema,
      last4: z.string(),
      createdAt: z.string(),
      createdBy: z.string(),
      baseUrl: z.string().nullable().optional(),
    }),
  ),
});
/** PUT (admin) /api/workspaces/:workspaceId/keys/:provider — validated with a cheap provider call before saving. */
export const SaveKeyRequestSchema = z.object({
  apiKey: z.string().min(8).max(500),
  baseUrl: z.string().url().optional(),
});
/** DELETE (admin) /api/workspaces/:workspaceId/keys/:provider → 204 */

export const CatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  efforts: z.array(z.string()),
  contextWindow: z.number().optional(),
});

export const ModelsResponseSchema = z.object({
  models: z.array(CatalogModelSchema),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

/**
 * POST (admin) /api/workspaces/:workspaceId/providers/:provider/models — a key typed in the
 * "add key" dialog, used for this one call: never stored, logged or echoed. `baseUrl` is for
 * `custom` only (https, public addresses; ADR-0010).
 */
export const ListModelsBodySchema = z.object({
  apiKey: z.string().min(1).max(500),
  baseUrl: z.string().url().max(500).optional(),
});

/**
 * POST (admin) /api/workspaces/:workspaceId/credentials/:provider/test — the stored key, or an
 * unsaved `apiKey` (test before saving); rate-limited to 10 per minute per workspace.
 */
export const TestConnectionBodySchema = z.object({
  apiKey: z.string().max(500).optional(),
  baseUrl: z.string().url().max(500).optional(),
  model: z.string().max(200).optional(),
  effort: EffortSchema.optional(),
});

export const TestConnectionResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ms: z.number(),
    model: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string(),
    message: z.string(),
    ms: z.number().optional(),
  }),
]);
export type TestConnectionResponse = z.infer<typeof TestConnectionResponseSchema>;

export const InstallationSchema = z.object({
  id: z.number().int(),
  accountLogin: z.string(),
  accountType: z.enum(['User', 'Organization']),
  repositorySelection: z.enum(['all', 'selected']),
  suspended: z.boolean(),
});
/** GET (member) /api/workspaces/:workspaceId/installations */
export const InstallationsResponseSchema = z.object({ installations: z.array(InstallationSchema) });
/**
 * POST (admin) /api/workspaces/:workspaceId/installations/:installationId/link → 204.
 * Allowed only when the signed-in user's GitHub account can access that installation
 * and it is not already linked to another workspace.
 */

/** GET /api/github/installations — signed in, GitHub linked: installations the user can access. */
export const GitHubInstallationsResponseSchema = z.object({
  installations: z.array(
    InstallationSchema.extend({ linkedWorkspaceId: z.string().nullable() }),
  ),
  installUrl: z.string().url(),
});

export const SeverityCountsSchema = z.object({
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  info: z.number(),
});
export type SeverityCounts = z.infer<typeof SeverityCountsSchema>;

export const ReviewRunFindingSchema = z.object({
  path: z.string(),
  line: z.number().optional(),
  endLine: z.number().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  category: z.string().optional(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type ReviewRunFinding = z.infer<typeof ReviewRunFindingSchema>;

export const ReviewRunResultSchema = z.object({
  v: z.literal(1),
  summary: z.string(),
  highlights: z.array(z.string()),
  findings: z.array(ReviewRunFindingSchema),
  outOfDiff: z.array(ReviewRunFindingSchema).optional(),
  language: z.enum(['ar', 'en']),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    })
    .optional(),
  verify: z
    .object({
      dropped: z.number(),
    })
    .optional(),
});
export type ReviewRunResult = z.infer<typeof ReviewRunResultSchema>;

export const ReviewRunSchema = z.object({
  id: z.string(),
  repoFullName: z.string(),
  pullNumber: z.number().int(),
  headSha: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'skipped', 'failed']),
  costUsd: z.number().nullable(),
  detail: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  fallbackFrom: z.string().nullable().optional(),
  findingsCount: z.number().nullable().optional(),
  severityCounts: SeverityCountsSchema.nullable().optional(),
  reviewUrl: z.string().nullable().optional(),
  /** From the run's result usage; null when unknown. */
  inputTokens: z.number().nullable().optional(),
  outputTokens: z.number().nullable().optional(),
});
export type ReviewRun = z.infer<typeof ReviewRunSchema>;

/** GET (member) /api/workspaces/:workspaceId/runs */
export const RunsResponseSchema = z.object({
  runs: z.array(ReviewRunSchema),
  total: z.number().optional(),
});
export type RunsResponse = z.infer<typeof RunsResponseSchema>;

/** One PR in the grouped runs list: its matching runs (newest first) and their sums. */
export const RunGroupSchema = z.object({
  repoFullName: z.string(),
  pullNumber: z.number().int(),
  runCount: z.number().int(),
  costUsd: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  runs: z.array(ReviewRunSchema),
});
export type RunGroup = z.infer<typeof RunGroupSchema>;

/**
 * GET (member) /api/workspaces/:workspaceId/runs?groupBy=pr — same filters and sort keys as the
 * flat list; paging is over PR groups (`total` groups) and sorting uses each group's latest run.
 */
export const RunGroupsResponseSchema = z.object({
  groups: z.array(RunGroupSchema),
  total: z.number().int(),
  totalRuns: z.number().int(),
});
export type RunGroupsResponse = z.infer<typeof RunGroupsResponseSchema>;

/** GET (member) /api/workspaces/:workspaceId/runs/:runId */
export const RunDetailResponseSchema = z.object({
  run: ReviewRunSchema.extend({
    result: ReviewRunResultSchema.nullable().optional(),
  }),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

/** GET (member) /api/workspaces/:workspaceId/runs/repos */
export const RunReposResponseSchema = z.object({
  repos: z.array(z.string()),
});
export type RunReposResponse = z.infer<typeof RunReposResponseSchema>;

export function computeSeverityCounts(
  findings?: Array<{ severity: 'critical' | 'high' | 'medium' | 'low' | 'info' }> | null,
  outOfDiff?: Array<{ severity: 'critical' | 'high' | 'medium' | 'low' | 'info' }> | null,
): SeverityCounts {
  const counts: SeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const list = [...(findings ?? []), ...(outOfDiff ?? [])];
  for (const f of list) {
    if (f.severity in counts) {
      counts[f.severity]++;
    }
  }
  return counts;
}

/** GET (member) /api/workspaces/:workspaceId/usage */
export const UsageResponseSchema = z.object({
  monthCostUsd: z.number(),
  monthlyBudgetUsd: z.number().nullable(),
  monthStart: z.string(),
});

/**
 * GET /app/installed?installation_id=&setup_action= — GitHub's post-install redirect.
 * Redirects to the web UI at `/install?installation_id=…` where the user picks a workspace.
 */

/** PATCH (admin/owner) /api/workspaces/:workspaceId — 1–60 chars after trim */
export const RenameWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type RenameWorkspaceRequest = z.infer<typeof RenameWorkspaceRequestSchema>;

export const RenameWorkspaceResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type RenameWorkspaceResponse = z.infer<typeof RenameWorkspaceResponseSchema>;

/** DELETE (owner) /api/workspaces/:workspaceId — confirmName, trimmed like rename, must equal the name */
export const DeleteWorkspaceRequestSchema = z.object({
  confirmName: z.string().trim(),
});
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;

/** POST (admin/owner) /api/workspaces/:workspaceId/runs/:runId/retry -> 202 */
export const RetryRunResponseSchema = z.object({
  runId: z.string(),
});
export type RetryRunResponse = z.infer<typeof RetryRunResponseSchema>;

/**
 * POST (admin/owner) /api/workspaces/:workspaceId/runs/retry-failed -> 200.
 * Body: the runs page's repo and date filters (validated server-side: ISO date or date-time,
 * `from` <= `to`, at most 50 repos). With `dryRun: true` nothing is queued and the rate limit is
 * untouched; the response lists what the real call would queue.
 */
export interface RetryFailedBody {
  repo?: string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
  dryRun?: boolean | undefined;
}

export const RetryItemSchema = z.object({
  repo: z.string(),
  pullNumber: z.number().int(),
});
export type RetryItem = z.infer<typeof RetryItemSchema>;

export const SkippedRetryItemSchema = RetryItemSchema.extend({
  reason: z.string(),
});
export type SkippedRetryItem = z.infer<typeof SkippedRetryItemSchema>;

export const RetryFailedResponseSchema = z.object({
  queued: z.number().int(),
  skipped: z.array(SkippedRetryItemSchema),
});
export type RetryFailedResponse = z.infer<typeof RetryFailedResponseSchema>;

export const RetryFailedDryRunResponseSchema = z.object({
  wouldQueue: z.number().int(),
  items: z.array(RetryItemSchema),
  skipped: z.array(SkippedRetryItemSchema),
});
export type RetryFailedDryRunResponse = z.infer<typeof RetryFailedDryRunResponseSchema>;
