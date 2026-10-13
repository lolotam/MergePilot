import { describe, expect, it } from 'vitest';
import type {
  AppStore,
  Installation,
  StoredCredential,
  WorkspaceSettings,
} from '../core/types.js';
import { defineDeleteWorkspaceContract } from './store-contract-delete.js';
import { defineReviewRunLifecycleContract } from './store-contract-runs.js';
import { defineRetryContract } from './store-contract-retry.js';
import { defineActiveRunContract } from './store-contract-active-run.js';
import { defineRetentionContract } from './store-contract-retention.js';
import { definePricesContract } from './store-contract-prices.js';
import { defineReviewerBotContract } from './store-contract-bots.js';

/** Workspaces the contract records review runs for; stores backed by Postgres must seed them. */
export const STORE_CONTRACT_WORKSPACES = [
  'ws-alpha',
  'ws-settings-test',
  'ws-cred-test',
  'ws-runs-test',
  'ws-del-target',
  'ws-del-other',
  'ws-k3',
  'ws-k3-other',
  'ws-bots',
  'ws-bots-other',
] as const;

export function describeStoreContract(
  suiteName: string,
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  describe(`AppStore contract: ${suiteName}`, { timeout: 20000 }, () => {
    it('records deliveries and deduplicates webhook deliveries', async () => {
      const store = await createStore();
      try {
        const first = await store.recordDelivery('del-1', 'pull_request.opened');
        expect(first).toBe(true);

        const duplicate = await store.recordDelivery('del-1', 'pull_request.opened');
        expect(duplicate).toBe(false);

        const another = await store.recordDelivery('del-2', 'check_run.completed');
        expect(another).toBe(true);
      } finally {
        await cleanup?.();
      }
    });

    it('manages installation lifecycle: pending, link, get, list, suspend, delete', async () => {
      const store = await createStore();
      try {
        const pending: Omit<Installation, 'workspaceId'> = {
          id: 101,
          accountLogin: 'acme-corp',
          accountType: 'Organization',
          repositorySelection: 'all',
          suspended: false,
        };

        await store.upsertPendingInstallation(pending);
        // Unlinked installations return null on getInstallation
        const beforeLink = await store.getInstallation(101);
        expect(beforeLink).toBeNull();

        // Listing for a workspace returns empty
        const listBefore = await store.listInstallations('ws-alpha');
        expect(listBefore).toEqual([]);

        // Link installation to workspace
        await store.linkInstallation(101, 'ws-alpha');
        const afterLink = await store.getInstallation(101);
        expect(afterLink).not.toBeNull();
        expect(afterLink?.id).toBe(101);
        expect(afterLink?.workspaceId).toBe('ws-alpha');
        expect(afterLink?.accountLogin).toBe('acme-corp');
        expect(afterLink?.suspended).toBe(false);

        // List shows linked installation
        const listAfter = await store.listInstallations('ws-alpha');
        expect(listAfter).toHaveLength(1);
        expect(listAfter[0]?.id).toBe(101);

        // Suspend installation
        await store.setInstallationSuspended(101, true);
        const suspended = await store.getInstallation(101);
        expect(suspended?.suspended).toBe(true);

        // Linking non-existent throws
        await expect(store.linkInstallation(99999, 'ws-alpha')).rejects.toThrow(
          'installation 99999 not found',
        );

        // Direct upsertInstallation
        const direct: Installation = {
          id: 102,
          workspaceId: 'ws-alpha',
          accountLogin: 'acme-tools',
          accountType: 'User',
          repositorySelection: 'selected',
          suspended: false,
        };
        await store.upsertInstallation(direct);
        const directFound = await store.getInstallation(102);
        expect(directFound?.accountLogin).toBe('acme-tools');

        // Delete installation
        await store.deleteInstallation(101);
        expect(await store.getInstallation(101)).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it('manages workspace settings', async () => {
      const store = await createStore();
      try {
        const notFound = await store.getSettings('ws-settings-test');
        expect(notFound).toBeNull();

        const initial: WorkspaceSettings = {
          workspaceId: 'ws-settings-test',
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-latest',
          language: 'ar',
          monthlyBudgetUsd: 50.0,
          effort: 'high',
          heavyProvider: 'openai',
          heavyModel: 'gpt-5',
          heavyEffort: 'medium',
          heavyThresholdLines: 1200,
          fallback: [{ provider: 'gemini', model: 'gemini-3.8-flash', effort: 'low' }],
          minSeverity: 'high',
        };
        await store.saveSettings(initial);

        const loaded = await store.getSettings('ws-settings-test');
        expect(loaded).not.toBeNull();
        expect(loaded?.workspaceId).toBe('ws-settings-test');
        expect(loaded?.provider).toBe('anthropic');
        expect(loaded?.model).toBe('claude-3-5-sonnet-latest');
        expect(loaded?.language).toBe('ar');
        expect(loaded?.monthlyBudgetUsd).toBe(50.0);
        expect(typeof loaded?.monthlyBudgetUsd).toBe('number');
        expect(loaded?.effort).toBe('high');
        expect(loaded?.heavyProvider).toBe('openai');
        expect(loaded?.heavyModel).toBe('gpt-5');
        expect(loaded?.heavyEffort).toBe('medium');
        expect(loaded?.heavyThresholdLines).toBe(1200);
        expect(loaded?.fallback).toEqual([{ provider: 'gemini', model: 'gemini-3.8-flash', effort: 'low' }]);
        expect(loaded?.minSeverity).toBe('high');

        // Update settings with null budget and reset optional fields
        const updated: WorkspaceSettings = {
          ...initial,
          provider: 'openai',
          model: 'gpt-4o',
          language: 'en',
          monthlyBudgetUsd: null,
          effort: null,
          heavyModel: null,
          heavyProvider: null,
          heavyEffort: null,
          fallback: [],
          minSeverity: 'medium',
        };
        await store.saveSettings(updated);

        const reloaded = await store.getSettings('ws-settings-test');
        expect(reloaded?.provider).toBe('openai');
        expect(reloaded?.monthlyBudgetUsd).toBeNull();
        expect(reloaded?.effort).toBeNull();
        expect(reloaded?.heavyModel).toBeNull();
        expect(reloaded?.fallback).toEqual([]);
        expect(reloaded?.minSeverity).toBe('medium');
        expect(reloaded?.judge).toBeNull();

        // The Jev judge (ADR-0015): saved with its fallbacks, kept when left out, cleared by null.
        const judge = {
          enabled: true,
          provider: 'typesafe' as const,
          model: 'jev-latest',
          uses: ['annotate' as const, 'filter' as const, 'dedupe' as const],
          threshold: 0.4,
          fallback: [{ provider: 'opencode-zen' as const, model: 'jev-1.13-free' }],
        };
        await store.saveSettings({ ...updated, judge });
        expect((await store.getSettings('ws-settings-test'))?.judge).toEqual(judge);
        await store.saveSettings(updated);
        expect((await store.getSettings('ws-settings-test'))?.judge).toEqual(judge);
        // An enabled judge with no uses (idle) round-trips as an empty set.
        await store.saveSettings({ ...updated, judge: { ...judge, uses: [] } });
        expect((await store.getSettings('ws-settings-test'))?.judge?.uses).toEqual([]);
        await store.saveSettings({ ...updated, judge: null });
        expect((await store.getSettings('ws-settings-test'))?.judge).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it('manages credentials and never includes ciphertext in listCredentials', async () => {
      const store = await createStore();
      try {
        const cred1: StoredCredential = {
          id: '11111111-1111-4111-8111-111111111111',
          workspaceId: 'ws-cred-test',
          provider: 'custom',
          ciphertext: 'enc:secret-cipher-text-1',
          keyVersion: 1,
          last4: 'sk-1',
          createdBy: 'user-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          baseUrl: 'https://custom-ai.internal/v1',
        };
        const cred2: StoredCredential = {
          id: '22222222-2222-4222-8222-222222222222',
          workspaceId: 'ws-cred-test',
          provider: 'gemini',
          ciphertext: 'enc:secret-cipher-text-2',
          keyVersion: 1,
          last4: 'sk-2',
          createdBy: 'user-2',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        };

        await store.saveCredential(cred1);
        await store.saveCredential(cred2);

        const fetched1 = await store.getCredential('ws-cred-test', 'custom');
        expect(fetched1).not.toBeNull();
        expect(fetched1?.ciphertext).toBe('enc:secret-cipher-text-1');
        expect(fetched1?.last4).toBe('sk-1');
        expect(fetched1?.baseUrl).toBe('https://custom-ai.internal/v1');

        // listCredentials MUST omit ciphertext and include baseUrl
        const listed = await store.listCredentials('ws-cred-test');
        expect(listed).toHaveLength(2);
        for (const item of listed) {
          expect(item).not.toHaveProperty('ciphertext');
        }
        const customListed = listed.find((k) => k.provider === 'custom');
        expect(customListed?.baseUrl).toBe('https://custom-ai.internal/v1');

        // Delete credential
        await store.deleteCredential('ws-cred-test', 'custom');
        const deleted = await store.getCredential('ws-cred-test', 'custom');
        expect(deleted).toBeNull();

        const listedAfter = await store.listCredentials('ws-cred-test');
        expect(listedAfter).toHaveLength(1);
        expect(listedAfter[0]?.provider).toBe('gemini');
      } finally {
        await cleanup?.();
      }
    });

    it('manages review runs: create, list, finish and monthCostUsd', async () => {
      const store = await createStore();
      try {
        const run1 = await store.createReviewRun({
          workspaceId: 'ws-runs-test',
          installationId: 42,
          repoFullName: 'org/repo',
          pullNumber: 12,
          headSha: 'abcd1234efgh5678',
          status: 'queued',
          costUsd: null,
          detail: null,
        });

        expect(run1.id).toBeDefined();
        expect(run1.workspaceId).toBe('ws-runs-test');
        expect(run1.status).toBe('queued');
        expect(run1.costUsd).toBeNull();
        expect(run1.finishedAt).toBeNull();
        expect(run1.createdAt).toBeInstanceOf(Date);

        // List review runs
        const runs = await store.listReviewRuns('ws-runs-test', 10);
        expect(runs).toHaveLength(1);
        expect(runs[0]?.id).toBe(run1.id);
        expect(typeof runs[0]?.installationId).toBe('number');
        expect(typeof runs[0]?.pullNumber).toBe('number');

        // Finish review run
        await store.finishReviewRun('ws-runs-test', run1.id, {
          status: 'completed',
          costUsd: 0.0425,
          detail: 'Reviewed 5 files',
        });

        const finishedRuns = await store.listReviewRuns('ws-runs-test', 10);
        expect(finishedRuns[0]?.status).toBe('completed');
        expect(finishedRuns[0]?.costUsd).toBe(0.0425);
        expect(typeof finishedRuns[0]?.costUsd).toBe('number');
        expect(finishedRuns[0]?.detail).toBe('Reviewed 5 files');
        expect(finishedRuns[0]?.finishedAt).toBeInstanceOf(Date);

        // Calculate month cost
        const monthStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const cost = await store.monthCostUsd('ws-runs-test', monthStart);
        expect(cost).toBeCloseTo(0.0425, 4);
        expect(typeof cost).toBe('number');
      } finally {
        await cleanup?.();
      }
    });

    it('records review run details and retrieves via getReviewRun', async () => {
      const store = await createStore();
      try {
        const payload = {
          v: 1 as const,
          summary: 'Review summary text',
          highlights: ['Fix memory leak', 'Add test coverage'],
          findings: [
            {
              path: 'src/index.ts',
              line: 10,
              severity: 'high' as const,
              title: 'Memory leak',
              body: 'Listener is not cleaned up',
            },
          ],
          language: 'en' as const,
          usage: { inputTokens: 120, outputTokens: 80 },
        };

        const run = await store.createReviewRun({
          workspaceId: 'ws-runs-test',
          installationId: 42,
          repoFullName: 'org/repo-details',
          pullNumber: 99,
          headSha: 'head-sha-123',
          status: 'running',
          costUsd: null,
          detail: null,
          jobId: 'job-meta-1',
        });

        await store.finishReviewRun('ws-runs-test', run.id, {
          status: 'completed',
          costUsd: 0.12,
          detail: null,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          effort: 'high',
          fallbackFrom: 'openai',
          findingsCount: 1,
          result: payload,
          reviewUrl: 'https://github.com/org/repo-details/pull/99#pullrequestreview-456',
        });

        const fetched = await store.getReviewRun('ws-runs-test', run.id);
        expect(fetched).not.toBeNull();
        expect(fetched?.provider).toBe('anthropic');
        expect(fetched?.model).toBe('claude-3-5-sonnet');
        expect(fetched?.effort).toBe('high');
        expect(fetched?.fallbackFrom).toBe('openai');
        expect(fetched?.findingsCount).toBe(1);
        expect(fetched?.result).toEqual(payload);
        expect(fetched?.reviewUrl).toBe('https://github.com/org/repo-details/pull/99#pullrequestreview-456');

        // Isolation: getReviewRun for different workspace returns null
        const otherWorkspace = await store.getReviewRun('ws-alpha', run.id);
        expect(otherWorkspace).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    defineReviewRunLifecycleContract(createStore, cleanup);
    defineDeleteWorkspaceContract(createStore, cleanup);
    defineRetryContract(createStore, cleanup);
    defineActiveRunContract(createStore, cleanup);
    defineRetentionContract(createStore, cleanup);
    definePricesContract(createStore, cleanup);
    defineReviewerBotContract(createStore, cleanup);
  });
}
