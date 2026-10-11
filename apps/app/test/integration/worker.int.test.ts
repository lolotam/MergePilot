import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewModel } from '@mergepilot/engine';
import type { CreateReviewParams, GitHubClient } from '@mergepilot/github';
import type { ReviewJob } from '../../src/core/types.js';
import { CredentialService } from '../../src/credentials/service.js';
import { EnvelopeVault } from '../../src/vault/envelope-vault.js';
import { processReviewJob } from '../../src/worker/process-review.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
} from './test-helper.js';

describe.skipIf(!hasIntegrationEnv)('worker end to end on real Postgres', () => {
  it('processes review job with PgStore, real vault/credentials, publishing review once and completing review run with cost', async () => {
    const ctx = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    try {
      const workspaceId = 'ws-worker-e2e';
      const installationId = 8888;
      const masterKey = randomBytes(32).toString('base64');
      const vault = new EnvelopeVault(masterKey);
      const credentials = new CredentialService({
        store: ctx.store,
        vault,
        validate: vi.fn().mockResolvedValue(true),
      });

      // 1. Save provider credential through real vault + CredentialService
      await credentials.saveKey({
        workspaceId,
        provider: 'anthropic',
        apiKey: 'sk-ant-test-key-worker-000',
        userId: 'user-worker-test',
      });

      // 2. Configure workspace settings in real Postgres
      await ctx.store.saveSettings({
        workspaceId,
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        language: 'en',
        monthlyBudgetUsd: 100,
      });

      // 3. Link installation in real Postgres
      await ctx.store.upsertInstallation({
        id: installationId,
        workspaceId,
        accountLogin: 'worker-test-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      // 4. Fake GitHub client recording created reviews
      const createdReviews: CreateReviewParams[] = [];
      const configYaml = `provider: anthropic
model: claude-3-5-sonnet
language: en
budget:
  pricing:
    inputPerMTok: 3.0
    outputPerMTok: 15.0
`;
      const fakeClient: GitHubClient = {
        getFileContent: async (params) => {
          if (params.path === '.mergepilot.yml') {
            return configYaml;
          }
          return null;
        },
        listPullRequestFilesPage: async () => [
          {
            filename: 'src/handler.ts',
            status: 'modified',
            additions: 3,
            deletions: 1,
            changes: 4,
            patch: '@@ -1,2 +1,4 @@\n-const old = 1;\n+const added = 2;\n+const extra = 3;',
          },
        ],
        getPullRequest: async () => ({
          head: { sha: 'sha-worker-head-111' },
          title: 'Worker integration test PR',
          body: 'PR body for testing',
        }),
        listReviewsPage: async () => [],
        createReview: async (params: CreateReviewParams) => {
          createdReviews.push(params);
          return { id: 777 };
        },
        compareCommits: async () => null,
      };

      // 5. Fake ReviewModel returning a fixed answer
      const fakeModel: ReviewModel = {
        label: 'anthropic:claude-3-5-sonnet',
        generate: vi.fn(async () => ({
          text: JSON.stringify({
            summary: 'Review completed successfully: clean implementation.',
            findings: [],
          }),
          finishReason: 'stop' as const,
          usage: { inputTokens: 150, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })),
      };

      const job: ReviewJob = {
        deliveryId: 'del-worker-e2e-888',
        installationId,
        repoFullName: 'worker-test-org/repo-worker',
        pullNumber: 99,
        headSha: 'sha-worker-head-111',
        baseSha: 'sha-worker-base-222',
      };

      // 6. Execute processReviewJob
      const result = await processReviewJob(job, {
        store: ctx.store,
        credentials,
        githubAppFactory: async () => ({
          client: fakeClient,
          publisherLogin: 'mergepilot[bot]',
        }),
        createModelForProvider: async () => fakeModel,
      });

      // 7. Verify result and review published exactly once
      expect(result.status).toBe('completed');
      expect(result.costUsd).not.toBeNull();
      expect(result.costUsd).toBeGreaterThanOrEqual(0);

      expect(createdReviews).toHaveLength(1);
      expect(createdReviews[0]?.body).toContain('Review completed successfully');
      expect(createdReviews[0]?.pull_number).toBe(99);

      // 8. Verify review_runs row in store
      const runs = await ctx.store.listReviewRuns(workspaceId, 10);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('completed');
      expect(runs[0]?.costUsd).toBe(result.costUsd);
      expect(runs[0]?.finishedAt).not.toBeNull();

      // 9. Verify raw PostgreSQL row holds completed status and cost
      const rawRes = await ctx.pool.query<{
        status: string;
        cost_usd: string;
        finished_at: Date;
      }>('SELECT status, cost_usd, finished_at FROM review_runs WHERE workspace_id = $1;', [
        workspaceId,
      ]);
      expect(rawRes.rows).toHaveLength(1);
      expect(rawRes.rows[0].status).toBe('completed');
      expect(Number(rawRes.rows[0].cost_usd)).toBeCloseTo(result.costUsd ?? 0, 4);
      expect(rawRes.rows[0].finished_at).not.toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
