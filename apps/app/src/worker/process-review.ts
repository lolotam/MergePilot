import { createHash } from 'node:crypto';
import {
  createReviewModel,
  MergePilotConfigSchema,
  redactSecrets,
  Secret,
  type CredentialInfo,
  type CredentialRef,
  type CredentialStore,
  type MergePilotConfig,
  type RequestPurpose,
  type ReviewModel,
} from '@mergepilot/engine';
import {
  loadRepoConfig,
  publishReview,
  renderReviewSummary,
  type FileContent,
} from '@mergepilot/github';
import {
  ActiveRunExistsError,
  WorkspaceDeletedError,
  type ApiProvider,
  type ReviewJob,
  type ReviewRun,
  type ReviewRunResultPayload,
  type ReviewRunStatus,
} from '../core/types.js';
import { executeReview } from './execute-review.js';
import { prepareRunResult } from './prepare-run-result.js';
import { startRunHeartbeat } from './run-heartbeat.js';
import { guardWritesForWorkspace } from './workspace-guard.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

const WORKSPACE_DELETED = 'workspace_deleted';
/** Another run for the same PR head is already queued/running (migration 0004); nothing is published. */
const DUPLICATE = 'duplicate';

class WorkspaceCredentialStore implements CredentialStore {
  constructor(
    private readonly provider: 'anthropic' | 'openai' | 'gemini',
    private readonly secret: Secret,
  ) {}

  async info(_ref: CredentialRef): Promise<CredentialInfo> {
    return {
      provider: this.provider,
      configured: true,
      source: 'env',
      envName: 'DATABASE',
    };
  }

  async resolve(_ref: CredentialRef, _purpose: RequestPurpose): Promise<Secret> {
    return this.secret;
  }
}

/**
 * Processes a PR review job dispatched from the webhook queue.
 */
export async function processReviewJob(
  job: ReviewJob,
  deps: ProcessReviewDeps,
): Promise<ProcessReviewResult> {
  const installation = await deps.store.getInstallation(job.installationId);
  if (!installation || installation.suspended) {
    deps.log?.(
      `Skipping job ${job.deliveryId}: installation ${job.installationId} is ${
        !installation ? 'unknown' : 'suspended'
      }`,
    );
    return {
      status: 'skipped',
      detail: !installation ? 'unknown installation' : 'suspended installation',
    };
  }

  const workspaceId = installation.workspaceId;

  const settings = await deps.store.getSettings(workspaceId);
  if (!settings) {
    let run: ReviewRun;
    try {
      run = await deps.store.createReviewRun({
        workspaceId,
        jobId: job.deliveryId,
        installationId: job.installationId,
        repoFullName: job.repoFullName,
        pullNumber: job.pullNumber,
        headSha: job.headSha,
        status: 'running',
        costUsd: null,
        detail: null,
      });
    } catch (error) {
      if (error instanceof ActiveRunExistsError) {
        deps.log?.(`Skipping job ${job.deliveryId}: a run for this head is already active`);
        return { status: 'skipped', detail: DUPLICATE };
      }
      if (!(error instanceof WorkspaceDeletedError)) throw error;
      deps.log?.(`Skipping job ${job.deliveryId}: workspace ${workspaceId} was deleted`);
      return { status: 'skipped', detail: WORKSPACE_DELETED };
    }
    await deps.store.finishReviewRun(workspaceId, run.id, {
      status: 'skipped',
      costUsd: null,
      detail: 'workspace not configured',
    });
    deps.log?.(`Skipping job ${job.deliveryId}: workspace ${workspaceId} not configured`);
    return { status: 'skipped', detail: 'workspace not configured' };
  }

  let run: ReviewRun | undefined;
  let secret: Secret | undefined;
  let stopHeartbeat: (() => void) | undefined;

  try {
    run = await deps.store.createReviewRun({
      workspaceId,
      jobId: job.deliveryId,
      installationId: job.installationId,
      repoFullName: job.repoFullName,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      status: 'running',
      costUsd: null,
      detail: null,
      provider: settings.provider,
      model: settings.model,
    });
    stopHeartbeat = startRunHeartbeat(deps.store, workspaceId, run.id, {
      intervalMs: deps.heartbeatIntervalMs,
      log: deps.log,
    });

    const [owner, repo] = job.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid repoFullName: ${job.repoFullName}`);
    }

    const { client: rawClient, publisherLogin } = await deps.githubAppFactory(job.installationId);
    const client = guardWritesForWorkspace(rawClient, deps.store, job.installationId, workspaceId);

    const pr = await client.getPullRequest({ owner, repo, pull_number: job.pullNumber });
    const prRecord = pr as unknown as { title?: string; body?: string | null };
    const prTitle = typeof prRecord.title === 'string' ? prRecord.title : '';
    const prBody = typeof prRecord.body === 'string' ? prRecord.body : '';

    const repoConfigResult = await loadRepoConfig(client, { owner, repo, baseSha: job.baseSha });

    let effectiveConfig: MergePilotConfig;
    let rulesFiles: FileContent[];
    let configHash: string;

    if ('missing' in repoConfigResult) {
      effectiveConfig = MergePilotConfigSchema.parse({
        provider: settings.provider,
        model: settings.model,
        language: settings.language,
      });
      rulesFiles = [];
      configHash = createHash('sha256')
        .update(
          JSON.stringify({
            provider: settings.provider,
            model: settings.model,
            language: settings.language,
          }),
        )
        .digest('hex')
        .slice(0, 12);
    } else if ('errors' in repoConfigResult) {
      throw new Error(`Invalid .mergepilot.yml:\n${repoConfigResult.errors.join('\n')}`);
    } else {
      // In the SaaS the workspace's dashboard settings choose the provider, model and review
      // language (the repo file may target the GitHub Action, e.g. `provider: claude-code`); the
      // repo still supplies its review rules and other settings.
      // A repo-provided baseUrl never reaches the effective config: a key must not be sent to a
      // URL from repository content (ADR-0008 amendment). The engine ignores it too.
      const { baseUrl: _repoBaseUrl, ...repoConfig } = repoConfigResult.config;
      const fallback = repoConfig.fallback.map(({ baseUrl: _fallbackBaseUrl, ...entry }) => entry);
      const sameModel =
        repoConfig.provider === settings.provider && repoConfig.model === settings.model;
      effectiveConfig = {
        ...repoConfig,
        fallback,
        provider: settings.provider,
        model: settings.model,
        language: settings.language,
        // Prices in the repo file describe the repo's own model; keep them only when it matches.
        budget: sameModel ? repoConfig.budget : { ...repoConfig.budget, pricing: undefined },
      };
      rulesFiles = repoConfigResult.rulesFiles;
      configHash = createHash('sha256')
        .update(repoConfigResult.configText)
        .digest('hex')
        .slice(0, 12);
    }

    // Check monthly budget if configured
    if (settings.monthlyBudgetUsd !== null && settings.monthlyBudgetUsd !== undefined) {
      const now = deps.now ? deps.now() : new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
      const currentMonthCost = await deps.store.monthCostUsd(workspaceId, monthStart);

      if (currentMonthCost >= settings.monthlyBudgetUsd) {
        const summaryMarkdown = renderReviewSummary({
          language: effectiveConfig.language,
          summary: '',
          summaryOnly: [],
          inlineCount: 0,
          complete: false,
          incompleteReasons: ['monthly budget reached'],
          modelLabel: effectiveConfig.model ?? effectiveConfig.provider,
          outcome: 'skipped-budget',
          reason: 'monthly budget reached',
        });

        const publishResult = await publishReview(client, {
          owner,
          repo,
          pull_number: job.pullNumber,
          expectedHeadSha: job.headSha,
          summaryMarkdown,
          inline: [],
          configHash,
          language: effectiveConfig.language,
          suggestionsAsCode: false,
          publisherLogin,
        });

        const budgetReviewUrl =
          'reviewId' in publishResult && typeof publishResult.reviewId === 'number'
            ? `https://github.com/${owner}/${repo}/pull/${job.pullNumber}#pullrequestreview-${publishResult.reviewId}`
            : null;

        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: 'monthly budget reached',
          provider: effectiveConfig.provider,
          model: effectiveConfig.model,
          effort: ((effectiveConfig.review as Record<string, unknown>)?.effort as string) ?? null,
          fallbackFrom: ((effectiveConfig as Record<string, unknown>)?.fallbackFrom as string) ?? null,
          findingsCount: 0,
          result: null,
          reviewUrl: budgetReviewUrl,
        });
        deps.log?.(`Monthly budget reached for workspace ${workspaceId}; skipping`);
        return { status: 'skipped', detail: 'monthly budget reached' };
      }
    }

    secret = await deps.credentials.resolve(
      workspaceId,
      effectiveConfig.provider as ApiProvider,
    );

    let model: ReviewModel;
    if (deps.createModelForProvider) {
      model = await deps.createModelForProvider(effectiveConfig, secret);
    } else {
      model = await createReviewModel(
        effectiveConfig,
        new WorkspaceCredentialStore(
          effectiveConfig.provider as 'anthropic' | 'openai' | 'gemini',
          secret,
        ),
        { cwd: process.cwd() },
      );
    }

    const reviewResult = await executeReview({
      client,
      owner,
      repo,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      baseSha: job.baseSha,
      prTitle,
      prBody,
      config: effectiveConfig,
      configHash,
      rulesFiles,
      model,
      knownSecrets: [secret],
      publisherLogin,
      ...(deps.log ? { log: deps.log } : {}),
    });

    const status: ReviewRunStatus =
      reviewResult.outcome === 'completed'
        ? 'completed'
        : reviewResult.outcome === 'skipped-budget'
          ? 'skipped'
          : 'failed';

    const costUsd = reviewResult.costUsd ?? null;
    const detail = reviewResult.detail ?? null;

    let payload: ReviewRunResultPayload | null = null;
    let findingsCount: number | null = null;

    if (reviewResult.runResult && reviewResult.runResult.status === 'completed') {
      const rr = reviewResult.runResult;
      payload = prepareRunResult({
        summary: rr.summary,
        inlineFindings: rr.inline,
        summaryOnlyFindings: rr.summaryOnly,
        language: effectiveConfig.language,
        usage: rr.usage,
        verification: rr.verification,
        knownSecrets: [secret],
      });
      findingsCount = rr.inline.length + rr.summaryOnly.length;
    } else if (status === 'skipped') {
      findingsCount = 0;
    }

    await deps.store.finishReviewRun(workspaceId, run.id, {
      status,
      costUsd,
      detail,
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
      effort: ((effectiveConfig.review as Record<string, unknown>)?.effort as string) ?? null,
      fallbackFrom: ((effectiveConfig as Record<string, unknown>)?.fallbackFrom as string) ?? null,
      findingsCount,
      result: payload,
      reviewUrl: reviewResult.reviewUrl ?? null,
    });

    return {
      status,
      costUsd,
      detail,
    };
  } catch (error) {
    if (error instanceof ActiveRunExistsError && !run) {
      // Thrown only by createReviewRun, before any GitHub call: end the job without publishing.
      deps.log?.(`Skipping job ${job.deliveryId}: a run for this head is already active`);
      return { status: 'skipped', detail: DUPLICATE };
    }
    if (error instanceof WorkspaceDeletedError) {
      deps.log?.(`Review job ${job.deliveryId} skipped: workspace ${workspaceId} was deleted`);
      if (run) {
        // No-op when the run was deleted with the workspace; kept for an unlink without deletion.
        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: WORKSPACE_DELETED,
        });
      }
      return { status: 'skipped', detail: WORKSPACE_DELETED };
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Always redact: errors before the key is loaded can still carry GitHub installation tokens.
    const redactedDetail = redactSecrets(rawMessage, secret ? [secret] : []).text.slice(0, 500);

    deps.log?.(`Review job ${job.deliveryId} failed: ${redactedDetail}`);

    if (run) {
      await deps.store.finishReviewRun(workspaceId, run.id, {
        status: 'failed',
        costUsd: null,
        detail: redactedDetail,
        provider: settings?.provider ?? null,
        model: settings?.model ?? null,
      });
    }

    return {
      status: 'failed',
      detail: redactedDetail,
    };
  } finally {
    stopHeartbeat?.();
  }
}
