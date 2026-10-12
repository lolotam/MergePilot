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
import { createSafeFetch } from '../core/safe-fetch.js';
import { executeReview } from './execute-review.js';
import { chooseModel, customBaseUrlFor, usedModel, type ModelChoice } from './model-choice.js';
import { prepareRunResult } from './prepare-run-result.js';
import { startRunHeartbeat } from './run-heartbeat.js';
import { guardWritesForWorkspace } from './workspace-guard.js';
import type { ProcessReviewCredentials, ProcessReviewDeps, ProcessReviewResult } from './types.js';

const WORKSPACE_DELETED = 'workspace_deleted';
const DUPLICATE = 'duplicate';

class WorkspaceCredentialStore implements CredentialStore {
  private readonly secrets = new Map<string, Secret>();

  constructor(
    private readonly workspaceId: string,
    private readonly credentials: ProcessReviewCredentials,
    primaryProvider: ApiProvider,
    primarySecret: Secret,
  ) {
    this.secrets.set(primaryProvider, primarySecret);
  }

  getKnownSecrets(): Secret[] {
    return Array.from(this.secrets.values());
  }

  async info(ref: CredentialRef): Promise<CredentialInfo> {
    return { provider: ref.provider, configured: true, source: 'env', envName: 'DATABASE' };
  }

  async resolve(ref: CredentialRef, _purpose: RequestPurpose): Promise<Secret> {
    const existing = this.secrets.get(ref.provider);
    if (existing) return existing;
    const resolved = await this.credentials.resolve(this.workspaceId, ref.provider as ApiProvider);
    this.secrets.set(ref.provider, resolved);
    return resolved;
  }
}

export async function processReviewJob(
  job: ReviewJob,
  deps: ProcessReviewDeps,
): Promise<ProcessReviewResult> {
  const installation = await deps.store.getInstallation(job.installationId);
  if (!installation || installation.suspended) {
    const detail = !installation ? 'unknown installation' : 'suspended installation';
    deps.log?.(`Skipping job ${job.deliveryId}: installation ${job.installationId} is ${detail}`);
    return { status: 'skipped', detail };
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
  let credStore: WorkspaceCredentialStore | undefined;
  let stopHeartbeat: (() => void) | undefined;
  // The workspace model until the PR size is known; then possibly the heavy-duty model.
  let choice: ModelChoice = chooseModel(settings, 0);

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
      provider: choice.provider,
      model: choice.model,
      effort: choice.effort,
    });
    stopHeartbeat = startRunHeartbeat(deps.store, workspaceId, run.id, {
      intervalMs: deps.heartbeatIntervalMs,
      log: deps.log,
    });

    const [owner, repo] = job.repoFullName.split('/');
    if (!owner || !repo) throw new Error(`Invalid repoFullName: ${job.repoFullName}`);

    const { client: rawClient, publisherLogin } = await deps.githubAppFactory(job.installationId);
    const client = guardWritesForWorkspace(rawClient, deps.store, job.installationId, workspaceId);

    const pr = await client.getPullRequest({ owner, repo, pull_number: job.pullNumber });
    const prRecord = pr as unknown as { title?: string; body?: string | null; additions?: number; deletions?: number };
    const prTitle = typeof prRecord.title === 'string' ? prRecord.title : '';
    const prBody = typeof prRecord.body === 'string' ? prRecord.body : '';

    const additions = typeof prRecord.additions === 'number' ? prRecord.additions : 0;
    const deletions = typeof prRecord.deletions === 'number' ? prRecord.deletions : 0;
    choice = chooseModel(settings, additions + deletions);
    if (choice.heavy) deps.log?.(`Large PR (${additions + deletions} changed lines): using the heavy-duty model`);
    const { provider: chosenProvider, model: chosenModel, effort: chosenEffort } = choice;

    const repoConfigResult = await loadRepoConfig(client, { owner, repo, baseSha: job.baseSha });

    // Fallback entries never carry a URL: a `custom` entry uses the workspace's one custom
    // server URL, passed to the engine as the trusted `customBaseUrl` (ADR-0008 amendment).
    const fallbackList = (settings.fallback ?? []).map((f) => ({
      provider: f.provider,
      model: f.model,
      ...(f.effort ? { effort: f.effort } : {}),
    }));
    const customBaseUrl = await customBaseUrlFor(
      deps.store,
      workspaceId,
      chosenProvider,
      fallbackList.map((f) => f.provider),
      deps.ssrfLookup,
    );

    let effectiveConfig: MergePilotConfig;
    let rulesFiles: FileContent[];
    let configHash: string;

    if ('missing' in repoConfigResult) {
      effectiveConfig = MergePilotConfigSchema.parse({
        provider: chosenProvider,
        model: chosenModel,
        ...(chosenEffort ? { effort: chosenEffort } : {}),
        fallback: fallbackList,
        language: settings.language,
        review: { minSeverity: settings.minSeverity ?? 'medium' },
      });
      rulesFiles = [];
      configHash = createHash('sha256')
        .update(JSON.stringify({ provider: chosenProvider, model: chosenModel, language: settings.language }))
        .digest('hex')
        .slice(0, 12);
    } else if ('errors' in repoConfigResult) {
      throw new Error(`Invalid .mergepilot.yml:\n${repoConfigResult.errors.join('\n')}`);
    } else {
      // In the SaaS the workspace's dashboard settings choose the provider, model, effort, fallbacks
      // and review language (the repo file may target the GitHub Action, e.g. `provider:
      // claude-code`); the repo still supplies its review rules and other settings.
      // A repo-provided baseUrl never reaches the effective config: a key must not be sent to a
      // URL from repository content (ADR-0008 amendment). The custom base URL comes only from the
      // workspace credential, through `customBaseUrl` below.
      const { baseUrl: _repoBaseUrl, effort: _repoEffort, ...repoConfig } = repoConfigResult.config;
      const sameModel = repoConfig.provider === chosenProvider && repoConfig.model === chosenModel;
      effectiveConfig = {
        ...repoConfig,
        provider: chosenProvider,
        model: chosenModel,
        ...(chosenEffort ? { effort: chosenEffort } : {}),
        fallback: fallbackList,
        language: settings.language,
        review: {
          ...repoConfig.review,
          minSeverity: settings.minSeverity ?? repoConfig.review.minSeverity,
        },
        budget: sameModel ? repoConfig.budget : { ...repoConfig.budget, pricing: undefined },
      };
      rulesFiles = repoConfigResult.rulesFiles;
      configHash = createHash('sha256').update(repoConfigResult.configText).digest('hex').slice(0, 12);
    }

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
          provider: chosenProvider,
          model: chosenModel,
          effort: chosenEffort,
          fallbackFrom: null,
          findingsCount: 0,
          result: null,
          reviewUrl: budgetReviewUrl,
        });
        deps.log?.(`Monthly budget reached for workspace ${workspaceId}; skipping`);
        return { status: 'skipped', detail: 'monthly budget reached' };
      }
    }

    const primarySecret = await deps.credentials.resolve(workspaceId, chosenProvider as ApiProvider);
    credStore = new WorkspaceCredentialStore(workspaceId, deps.credentials, chosenProvider as ApiProvider, primarySecret);

    let model: ReviewModel;
    if (deps.createModelForProvider) {
      model = await deps.createModelForProvider(effectiveConfig, primarySecret);
    } else {
      model = await createReviewModel(effectiveConfig, credStore, {
        cwd: process.cwd(),
        ...(customBaseUrl
          ? { customBaseUrl, customFetch: deps.customFetch ?? createSafeFetch({ lookup: deps.ssrfLookup }) }
          : {}),
      });
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
      knownSecrets: credStore.getKnownSecrets(),
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
        knownSecrets: credStore.getKnownSecrets(),
      });
      findingsCount = rr.inline.length + rr.summaryOnly.length;
    } else if (status === 'skipped') {
      findingsCount = 0;
    }

    const used = usedModel(choice, settings, reviewResult.modelUsed, reviewResult.fallbackFrom);
    await deps.store.finishReviewRun(workspaceId, run.id, {
      status,
      costUsd,
      detail,
      provider: used.provider,
      model: used.model,
      effort: used.effort,
      fallbackFrom: used.fallbackFrom,
      findingsCount,
      result: payload,
      reviewUrl: reviewResult.reviewUrl ?? null,
    });

    return { status, costUsd, detail };
  } catch (error) {
    if (error instanceof ActiveRunExistsError && !run) {
      deps.log?.(`Skipping job ${job.deliveryId}: a run for this head is already active`);
      return { status: 'skipped', detail: DUPLICATE };
    }
    if (error instanceof WorkspaceDeletedError) {
      deps.log?.(`Review job ${job.deliveryId} skipped: workspace ${workspaceId} was deleted`);
      if (run) {
        await deps.store.finishReviewRun(workspaceId, run.id, {
          status: 'skipped',
          costUsd: null,
          detail: WORKSPACE_DELETED,
        });
      }
      return { status: 'skipped', detail: WORKSPACE_DELETED };
    }
    const rawMessage = error instanceof Error ? error.message : String(error);
    const known = credStore?.getKnownSecrets() ?? [];
    const redactedDetail = redactSecrets(rawMessage, known).text.slice(0, 500);

    deps.log?.(`Review job ${job.deliveryId} failed: ${redactedDetail}`);

    if (run) {
      await deps.store.finishReviewRun(workspaceId, run.id, {
        status: 'failed',
        costUsd: null,
        detail: redactedDetail,
        provider: choice.provider,
        model: choice.model,
        effort: choice.effort,
      });
    }

    return { status: 'failed', detail: redactedDetail };
  } finally {
    stopHeartbeat?.();
  }
}
