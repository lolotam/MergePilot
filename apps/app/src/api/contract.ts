import { z } from 'zod';

/**
 * Dashboard REST contract (wave F). The API routes (apps/app/src/api) and the web UI
 * (apps/web) both build against these shapes. Auth itself (sign-in, sessions, workspace
 * creation, invitations, members) is Better Auth's own `/api/auth/*` endpoints.
 *
 * Every route below requires a signed-in session. Workspace routes take
 * `:workspaceId` and enforce the role noted next to them (ADR-0007).
 */

export const ApiProviderSchema = z.enum(['anthropic', 'openai', 'gemini']);

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

/** GET (member) / PUT (admin) /api/workspaces/:workspaceId/settings */
export const SettingsSchema = z.object({
  provider: ApiProviderSchema,
  model: z.string().min(1),
  language: z.enum(['ar', 'en']),
  monthlyBudgetUsd: z.number().positive().nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsResponseSchema = z.object({ settings: SettingsSchema.nullable() });

/** GET (admin) /api/workspaces/:workspaceId/keys */
export const KeysResponseSchema = z.object({
  keys: z.array(
    z.object({ provider: ApiProviderSchema, last4: z.string(), createdAt: z.string(), createdBy: z.string() }),
  ),
});
/** PUT (admin) /api/workspaces/:workspaceId/keys/:provider — validated with a cheap provider call before saving. */
export const SaveKeyRequestSchema = z.object({ apiKey: z.string().min(8).max(500) });
/** DELETE (admin) /api/workspaces/:workspaceId/keys/:provider → 204 */

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
});
export type ReviewRun = z.infer<typeof ReviewRunSchema>;

/** GET (member) /api/workspaces/:workspaceId/runs */
export const RunsResponseSchema = z.object({
  runs: z.array(ReviewRunSchema),
  total: z.number().optional(),
});
export type RunsResponse = z.infer<typeof RunsResponseSchema>;

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
