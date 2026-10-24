import { vi } from 'vitest';
import { Secret, type MergePilotConfig, type ReviewModel } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient, GitHubReview, GitHubReviewComment } from '@mergepilot/github';
import pino from 'pino';
import { MemoryStore } from '../core/memory-store.js';
import { usageMonth, type ApiProvider, type ReviewerBot, type ReviewJob, type WorkspaceSettings } from '../core/types.js';
import type { ProcessReviewDeps } from './types.js';

// Test fixture for the reviewer panel (ADR-0017): a workspace with a main bot and extra bots, a
// fake GitHub client that remembers what was published, and fake models keyed by model name.

export const WS = 'ws-panel';
export const INSTALLATION = 31;
export const HEAD = 'sha-panel-head';
export const BASE_URL = 'https://mp.example.com';
export const PUBLISHER = 'mergepilot[bot]';

/** A finding the fake model reports on the one added line of `src/app.ts`. */
export function finding(title: string, severity = 'medium', line = 2): Record<string, unknown> {
  return { path: 'src/app.ts', line, severity, category: 'correctness', title, body: `${title} body`, evidence: 'added line', confidence: 0.9 };
}

export interface PanelSetupOptions {
  bots?: Array<Partial<ReviewerBot> & { slot: number }>;
  settings?: Partial<WorkspaceSettings>;
  /** Providers without a stored key. */
  noKey?: ApiProvider[];
  /** Findings per model name; a model left out finds nothing. */
  findings?: Record<string, Array<Record<string, unknown>>>;
  /** Models whose call throws. */
  failing?: string[];
  reviews?: GitHubReview[];
  comments?: GitHubReviewComment[];
  monthlyCost?: number;
  /** Repository files at the base commit, by path (e.g. `.mergepilot.yml`). */
  repoFiles?: Record<string, string>;
}

export async function panelSetup(options: PanelSetupOptions = {}) {
  const store = new MemoryStore();
  await store.upsertInstallation({
    id: INSTALLATION, workspaceId: WS, accountLogin: 'acme', accountType: 'Organization', repositorySelection: 'all', suspended: false,
  });
  await store.saveSettings({
    workspaceId: WS, provider: 'anthropic', model: 'main-model', language: 'en', monthlyBudgetUsd: null, ...options.settings,
  });
  for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
    if (options.noKey?.includes(provider)) continue;
    await store.saveCredential({
      id: `cred-${provider}`, workspaceId: WS, provider, ciphertext: 'ciphertext', keyVersion: 1, last4: '0000', createdBy: 'u', createdAt: new Date(),
    });
  }
  for (const bot of options.bots ?? []) {
    await store.upsertReviewerBot(WS, {
      name: `Bot ${bot.slot}`, logo: 'owl', active: true, provider: 'openai', model: `bot${bot.slot}-model`, effort: null, fallback: [], exploreEnabled: false, ...bot,
    });
  }
  if (options.monthlyCost !== undefined) {
    const month = usageMonth(new Date('2026-10-12T12:00:00Z'));
    store.usage.set(`${WS}\u0000${month}`, {
      workspaceId: WS, month, costUsd: options.monthlyCost, runsTotal: 1, runsCompleted: 1, runsFailed: 0, inputTokens: 0, outputTokens: 0,
    });
  }

  const created: CreateReviewParams[] = [];
  const reviews: GitHubReview[] = [...(options.reviews ?? [])];
  const client: GitHubClient = {
    getFileContent: async ({ path }) => options.repoFiles?.[path] ?? null,
    listPullRequestFilesPage: vi.fn(async () => [
      { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n context\n+added line' },
    ]),
    getPullRequest: async () => ({ head: { sha: HEAD } }),
    listReviewsPage: async () => [...reviews],
    listReviewCommentsPage: async () => options.comments ?? [],
    createReview: async (params) => {
      created.push(params);
      const id = 1000 + created.length;
      reviews.push({ id, body: params.body, user: { login: PUBLISHER } });
      return { id };
    },
    compareCommits: async () => null,
  };

  let active = 0;
  const flight = { max: 0 };
  const calledModels: string[] = [];
  /** Every model call's system prompt, by model name. */
  const systems: Array<{ model: string; system: string }> = [];
  const createModelForProvider = vi.fn(async (config: MergePilotConfig, _secret: Secret): Promise<ReviewModel> => {
    const name = config.model ?? '';
    return {
      label: `${config.provider}:${name}`,
      generate: vi.fn(async (request: { system: string }) => {
        systems.push({ model: name, system: request.system });
        if (!calledModels.includes(name)) calledModels.push(name);
        active++;
        flight.max = Math.max(flight.max, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        if (options.failing?.includes(name)) throw new Error(`model ${name} exploded`);
        return {
          // `verdicts` answers the verification pass: no verdict keeps every finding.
          text: JSON.stringify({ summary: `${name} summary`, findings: options.findings?.[name] ?? [], verdicts: [] }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      }),
    };
  });

  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const deps: ProcessReviewDeps = {
    store,
    credentials: { resolve: vi.fn(async () => new Secret('sk-panel-test-key-0000')) },
    githubAppFactory: vi.fn(async () => ({ client, publisherLogin: PUBLISHER })),
    createModelForProvider,
    logger,
    baseUrl: BASE_URL,
    now: () => new Date('2026-10-12T12:00:00Z'),
  };
  const job: ReviewJob = { deliveryId: 'del-panel', installationId: INSTALLATION, repoFullName: 'acme/repo', pullNumber: 7, headSha: HEAD, baseSha: 'sha-base' };
  const runs = async () => (await store.listReviewRuns(WS, 50)).sort((a, b) => (a.botSlot ?? 1) - (b.botSlot ?? 1));
  const events = (name: string) => lines.filter((l) => l.event === name);
  return { store, deps, job, created, client, createModelForProvider, flight, calledModels, systems, runs, events };
}
