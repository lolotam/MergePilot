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
});
/** GET (member) /api/workspaces/:workspaceId/runs?limit=50 (max 200) */
export const RunsResponseSchema = z.object({ runs: z.array(ReviewRunSchema) });

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
