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
  reviewPullRequest,
  type FileContent,
} from '@mergepilot/github';
import type { ApiProvider, ReviewJob, ReviewRun, ReviewRunStatus } from '../core/types.js';
import type { ProcessReviewDeps, ProcessReviewResult } from './types.js';

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
    const run = await deps.store.createReviewRun({
      workspaceId,
      installationId: job.installationId,
      repoFullName: job.repoFullName,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      status: 'running',
      costUsd: null,
      detail: null,
    });
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

  try {
    run = await deps.store.createReviewRun({
      workspaceId,
      installationId: job.installationId,
      repoFullName: job.repoFullName,
      pullNumber: job.pullNumber,
      headSha: job.headSha,
      status: 'running',
      costUsd: null,
      detail: null,
    });

    const [owner, repo] = job.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(`Invalid repoFullName: ${job.repoFullName}`);
    }

    const { client, publisherLogin } = await deps.githubAppFactory(job.installationId);

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
      if (repoConfigResult.config.provider === 'claude-code') {
        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: 'subscription mode is not available in the SaaS',
        });
        deps.log?.('Skipping job: subscription mode is not available in the SaaS');
        return { status: 'skipped', detail: 'subscription mode is not available in the SaaS' };
      }
      effectiveConfig = repoConfigResult.config;
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

        await publishReview(client, {
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

        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: 'monthly budget reached',
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

    const reviewResult = await reviewPullRequest({
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

    await deps.store.finishReviewRun(workspaceId, run.id, {
      status,
      costUsd,
      detail,
    });

    return {
      status,
      costUsd,
      detail,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    // Always redact: errors before the key is loaded can still carry GitHub installation tokens.
    const redactedDetail = redactSecrets(rawMessage, secret ? [secret] : []).text.slice(0, 500);

    deps.log?.(`Review job ${job.deliveryId} failed: ${redactedDetail}`);

    if (run) {
      await deps.store.finishReviewRun(workspaceId, run.id, {
        status: 'failed',
        costUsd: null,
        detail: redactedDetail,
      });
    }

    return {
      status: 'failed',
      detail: redactedDetail,
    };
  }
}
