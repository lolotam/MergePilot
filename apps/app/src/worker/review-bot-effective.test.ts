import { describe, expect, it, vi } from 'vitest';
import { LlmFailure, Secret, type MergePilotConfig, type ReviewModel } from '@mergepilot/engine';
import type { GitHubClient } from '@mergepilot/github';
import pino from 'pino';
import { MemoryStore } from '../core/memory-store.js';
import { MAIN_BOT_SLOT, type ReviewJob, type WorkspaceSettings } from '../core/types.js';
import type { BotConfig } from './bot-config.js';
import type { PanelContext, BotRun } from './panel-types.js';
import { runBot } from './review-bot.js';
import type { ProcessReviewDeps } from './types.js';

async function runWithModel(
  provider: 'openai' | 'anthropic' | 'zai-coding',
  modelId: string,
  reviewModel: ReviewModel,
  verify = false,
  prices: Array<{ provider: string; model: string; inputPerMTok: number; outputPerMTok: number }> = [],
) {
  const store = new MemoryStore();
  const settings: WorkspaceSettings = { workspaceId: 'ws-bot', provider, model: modelId, language: 'en', monthlyBudgetUsd: null };
  await store.saveSettings(settings);
  if (prices.length > 0) {
    await store.replaceModelPrices('models.dev', prices.map((price) => ({ ...price, source: 'models.dev' as const })), new Date());
  }
  const logger = pino({ level: 'silent' });
  const deps: ProcessReviewDeps = {
    store,
    credentials: { resolve: async () => new Secret('test-credential') },
    githubAppFactory: vi.fn(),
    createModelForProvider: async () => reviewModel,
    logger,
  };
  const run = await store.createReviewRun({
    workspaceId: 'ws-bot', installationId: 1, repoFullName: 'acme/repo', pullNumber: 1, headSha: 'sha',
    status: 'running', costUsd: null, detail: null, botSlot: MAIN_BOT_SLOT,
  });
  const mainConfig: BotConfig = {
    effectiveConfig: {
      provider, model: modelId, language: 'en',
      review: { maxFindings: 5, minSeverity: 'medium', rulesFiles: [], exclude: [], pathInstructions: [], instructions: [], verify },
      budget: { perReviewUsd: 1, maxInputTokens: 10000, pricing: { inputPerMTok: 0, outputPerMTok: 0 } },
    },
    rulesFiles: [], configHash: 'cfg', pricing: { source: 'catalog:models.dev', inputPerMTok: 0, outputPerMTok: 0 },
  };
  const client: GitHubClient = {
    getFileContent: async () => null, listPullRequestFilesPage: async () => [], getPullRequest: async () => ({ head: { sha: 'sha' } }),
    listReviewsPage: async () => [], createReview: async () => ({ id: 1 }), compareCommits: async () => null,
  };
  const ctx: PanelContext = {
    job: { deliveryId: 'del', installationId: 1, repoFullName: 'acme/repo', pullNumber: 1, headSha: 'sha', baseSha: 'base' },
    deps, logger, workspaceId: 'ws-bot', settings, owner: 'acme', repo: 'repo', client, publisherLogin: 'bot',
    prTitle: 't', prBody: 'b', repoConfigResult: { config: null, rulesFiles: [], repoPricing: null },
    mainChoice: { provider, model: modelId, effort: null, heavy: false }, mainConfig, panelActive: false, mode: 'separate', startTime: 0,
  };
  const br: BotRun = {
    bot: { slot: MAIN_BOT_SLOT, name: 'Main', logo: 'pilot', provider, model: modelId, effort: null, fallback: [], exploreEnabled: false },
    run, stopHeartbeat: () => {}, startedAt: 0,
  };
  await runBot(ctx, br);
  return { store, run: await store.getReviewRun('ws-bot', run.id) };
}

const usage = { inputTokens: 100, outputTokens: 50 };
const answer = JSON.stringify({ summary: 'ok', findings: [], verdicts: [] });

describe('runBot effective auth (ADR-0027)', () => {
  it('uses resolveKeyRoster without calling resolve when the effective default is api-key', async () => {
    const store = new MemoryStore();
    const settings: WorkspaceSettings = {
      workspaceId: 'ws-bot',
      provider: 'openai',
      model: 'gpt-test',
      language: 'en',
      monthlyBudgetUsd: null,
    };
    await store.saveSettings(settings);

    const apiSecret = new Secret(['sk', 'openai', 'effective', '0001'].join('-'));
    const resolve = vi.fn(async () => new Secret('mergepilot:oauth:v1:should-not-run'));
    const resolveKeyRoster = vi.fn(async () => ({
      secrets: [apiSecret],
      keyIds: ['kid-1'],
      startIndex: 0,
    }));
    const getEffectiveAuthMethod = vi.fn(async () => 'api-key' as const);

    const createModelForProvider = vi.fn(async (_config: MergePilotConfig, secret: Secret): Promise<ReviewModel> => {
      expect(secret.reveal()).toBe(apiSecret.reveal());
      return {
        label: 'openai:gpt-test',
        generate: vi.fn(async () => ({
          text: JSON.stringify({ summary: 'ok', findings: [], verdicts: [] }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })),
      };
    });

    const client: GitHubClient = {
      getFileContent: async () => null,
      listPullRequestFilesPage: async () => [],
      getPullRequest: async () => ({ head: { sha: 'sha' } }),
      listReviewsPage: async () => [],
      createReview: async () => ({ id: 1 }),
      compareCommits: async () => null,
    };

    const deps: ProcessReviewDeps = {
      store,
      credentials: { resolve, resolveKeyRoster, getEffectiveAuthMethod },
      githubAppFactory: vi.fn(),
      createModelForProvider,
      logger: pino({ level: 'silent' }),
    };

    const run = await store.createReviewRun({
      workspaceId: 'ws-bot',
      installationId: 1,
      repoFullName: 'acme/repo',
      pullNumber: 1,
      headSha: 'sha',
      status: 'running',
      costUsd: null,
      detail: null,
      botSlot: MAIN_BOT_SLOT,
    });

    const mainConfig: BotConfig = {
      effectiveConfig: {
        provider: 'openai',
        model: 'gpt-test',
        language: 'en',
        review: { maxFindings: 5, minSeverity: 'medium', rulesFiles: [], exclude: [], pathInstructions: [], instructions: [] },
        budget: { perReviewUsd: 1, maxInputTokens: 1000, pricing: { inputPerMTok: 1, outputPerMTok: 1 } },
      },
      rulesFiles: [],
      configHash: 'cfg',
      pricing: { source: 'catalog', inputPerMTok: 1, outputPerMTok: 1 },
    };

    const ctx: PanelContext = {
      job: { deliveryId: 'del', installationId: 1, repoFullName: 'acme/repo', pullNumber: 1, headSha: 'sha', baseSha: 'base' } as ReviewJob,
      deps,
      logger: deps.logger!,
      workspaceId: 'ws-bot',
      settings,
      owner: 'acme',
      repo: 'repo',
      client,
      publisherLogin: 'bot',
      prTitle: 't',
      prBody: 'b',
      repoConfigResult: { config: null, rulesFiles: [], repoPricing: null },
      mainChoice: { provider: 'openai', model: 'gpt-test', effort: null, heavy: false },
      mainConfig,
      panelActive: false,
      mode: 'separate',
      startTime: 0,
    };

    const br: BotRun = {
      bot: {
        slot: MAIN_BOT_SLOT,
        name: 'Main',
        logo: 'pilot',
        provider: 'openai',
        model: 'gpt-test',
        effort: null,
        fallback: [],
        exploreEnabled: false,
      },
      run,
      stopHeartbeat: () => {},
      startedAt: 0,
    };

    await runBot(ctx, br);

    expect(getEffectiveAuthMethod).toHaveBeenCalledWith('ws-bot', 'openai');
    expect(resolveKeyRoster).toHaveBeenCalledWith('ws-bot', 'openai');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('runBot API-equivalent subscription usage (ADR-0047)', () => {
  it('stores the equivalent of a subscription model fallback', async () => {
    const primary: ReviewModel = {
      label: 'openai:gpt-x', includedInSubscription: true,
      generate: async () => { throw new LlmFailure({ code: 'QUOTA', provider: 'openai', message: 'quota' }); },
    };
    const fallback: ReviewModel = { label: 'anthropic:claude-x', includedInSubscription: true, generate: async () => ({ text: answer, finishReason: 'stop', usage }) };
    const { run } = await runWithModel('openai', 'gpt-x', { ...primary, fallbacks: [fallback] }, false, [
      { provider: 'anthropic', model: 'claude-x', inputPerMTok: 2, outputPerMTok: 4 },
    ]);
    expect(run?.result?.pricing?.source).toBe('subscription');
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo(0.0004);
    expect(run?.result?.pricing?.apiEquivalentByModel?.[0]).toMatchObject({ provider: 'anthropic', model: 'claude-x' });
  });

  it('keeps the token-plan equivalent path unchanged', async () => {
    const model: ReviewModel = { label: 'zai-coding:glm-x', generate: async () => ({ text: answer, finishReason: 'stop', usage }) };
    const { run } = await runWithModel('zai-coding', 'glm-x', model, false, [
      { provider: 'zai-coding', model: 'glm-x', inputPerMTok: 0, outputPerMTok: 0 },
      { provider: 'zai', model: 'glm-x', inputPerMTok: 2, outputPerMTok: 4 },
    ]);
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo(0.0004);
    expect(run?.result?.pricing?.apiEquivalentByModel).toBeUndefined();
  });

  it('keeps a plain subscription run at the ADR-0024 equivalent, with no model breakdown', async () => {
    const model: ReviewModel = { label: 'openai:gpt-x', includedInSubscription: true, generate: async () => ({ text: answer, finishReason: 'stop', usage }) };
    const { run } = await runWithModel('openai', 'gpt-x', model, false, [
      { provider: 'openai', model: 'gpt-x', inputPerMTok: 2, outputPerMTok: 4 },
    ]);
    expect(run?.result?.pricing?.source).toBe('subscription');
    expect(run?.result?.pricing?.apiEquivalentUsd).toBeCloseTo(0.0004);
    expect(run?.result?.pricing?.apiEquivalentByModel).toBeUndefined();
  });
});
