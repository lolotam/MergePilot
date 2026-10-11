import { describe, expect, it } from 'vitest';
import type { StoredCredential, WorkspaceSettings } from '../core/types.js';
import { createTestDb } from './index.js';
import { describeStoreContract } from './store-contract.js';

// 1. Shared AppStore contract tests against PgStore
describeStoreContract(
  'PgStore',
  async () => {
    const handle = await createTestDb();
    return handle.store;
  },
);

// 2. Negative isolation tests and specific requirements
describe('PgStore isolation and specific requirements', { timeout: 20000 }, () => {
  it('prevents workspace B from reading, listing, deleting or altering workspace A credentials', async () => {
    const { store, close } = await createTestDb();
    try {
      const credA: StoredCredential = {
        id: '11111111-1111-4111-8111-111111111111',
        workspaceId: 'ws-a',
        provider: 'anthropic',
        ciphertext: 'enc:secret-cipher-a',
        keyVersion: 1,
        last4: 'sk-a',
        createdBy: 'user-a',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      await store.saveCredential(credA);

      // Workspace B cannot read Workspace A's credential
      const credBRead = await store.getCredential('ws-b', 'anthropic');
      expect(credBRead).toBeNull();

      // Workspace B listCredentials returns empty array
      const credBList = await store.listCredentials('ws-b');
      expect(credBList).toEqual([]);

      // Workspace B deleting credential has no effect on Workspace A
      await store.deleteCredential('ws-b', 'anthropic');
      const credAAfterBDelete = await store.getCredential('ws-a', 'anthropic');
      expect(credAAfterBDelete).not.toBeNull();
      expect(credAAfterBDelete?.last4).toBe('sk-a');

      // Workspace A listCredentials never includes ciphertext
      const credAList = await store.listCredentials('ws-a');
      expect(credAList).toHaveLength(1);
      expect(credAList[0]).not.toHaveProperty('ciphertext');
      expect(Object.keys(credAList[0])).not.toContain('ciphertext');
    } finally {
      await close();
    }
  });

  it('prevents workspace B from reading or altering workspace A settings', async () => {
    const { store, close } = await createTestDb();
    try {
      const settingsA: WorkspaceSettings = {
        workspaceId: 'ws-a',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-latest',
        language: 'ar',
        monthlyBudgetUsd: 150.75,
      };
      await store.saveSettings(settingsA);

      // Workspace B cannot read Workspace A's settings
      const settingsB = await store.getSettings('ws-b');
      expect(settingsB).toBeNull();

      // Workspace A settings can be read and numeric budget maps to JS number
      const readA = await store.getSettings('ws-a');
      expect(readA?.monthlyBudgetUsd).toBe(150.75);
      expect(typeof readA?.monthlyBudgetUsd).toBe('number');
    } finally {
      await close();
    }
  });

  it('prevents workspace B from listing or finishing workspace A review runs', async () => {
    const { store, close } = await createTestDb();
    try {
      const runA = await store.createReviewRun({
        workspaceId: 'ws-a',
        installationId: 100,
        repoFullName: 'org/repo-a',
        pullNumber: 1,
        headSha: 'sha-a-1',
        status: 'queued',
        costUsd: null,
        detail: null,
      });

      // Workspace B cannot list Workspace A's run
      const runsB = await store.listReviewRuns('ws-b', 10);
      expect(runsB).toEqual([]);

      // Workspace B cannot finish Workspace A's run
      await store.finishReviewRun('ws-b', runA.id, {
        status: 'completed',
        costUsd: 99.99,
        detail: 'Hijacked by B',
      });

      // Run A remains unchanged
      const runsA = await store.listReviewRuns('ws-a', 10);
      expect(runsA).toHaveLength(1);
      expect(runsA[0].status).toBe('queued');
      expect(runsA[0].costUsd).toBeNull();
      expect(runsA[0].detail).toBeNull();
      expect(runsA[0].finishedAt).toBeNull();

      // Finishing with correct workspaceId succeeds
      await store.finishReviewRun('ws-a', runA.id, {
        status: 'completed',
        costUsd: 1.25,
        detail: 'Finished by A',
      });
      const finishedRunsA = await store.listReviewRuns('ws-a', 10);
      expect(finishedRunsA[0].status).toBe('completed');
      expect(finishedRunsA[0].costUsd).toBe(1.25);
      expect(typeof finishedRunsA[0].costUsd).toBe('number');
      expect(finishedRunsA[0].detail).toBe('Finished by A');
    } finally {
      await close();
    }
  });

  it('prevents workspace B from listing workspace A installations', async () => {
    const { store, close } = await createTestDb();
    try {
      await store.upsertInstallation({
        id: 7001,
        workspaceId: 'ws-a',
        accountLogin: 'acme-a',
        accountType: 'Organization',
        repositorySelection: 'all',
        suspended: false,
      });

      const listB = await store.listInstallations('ws-b');
      expect(listB).toEqual([]);

      const listA = await store.listInstallations('ws-a');
      expect(listA).toHaveLength(1);
      expect(listA[0].id).toBe(7001);
      expect(typeof listA[0].id).toBe('number');
    } finally {
      await close();
    }
  });

  it('duplicate webhook delivery returns false', async () => {
    const { store, close } = await createTestDb();
    try {
      const first = await store.recordDelivery('delivery-dup-test', 'pull_request');
      expect(first).toBe(true);

      const duplicate = await store.recordDelivery('delivery-dup-test', 'pull_request');
      expect(duplicate).toBe(false);

      const third = await store.recordDelivery('delivery-dup-test', 'pull_request');
      expect(third).toBe(false);
    } finally {
      await close();
    }
  });

  it('monthCostUsd sums only that workspace and month', async () => {
    const { store, client, close } = await createTestDb();
    try {
      const now = Date.now();
      const monthStart = new Date(now - 10 * 24 * 60 * 60 * 1000); // 10 days ago

      // Run 1: Workspace A, moved to 40 days ago (prior month) ($0.50)
      const r1 = await store.createReviewRun({
        workspaceId: 'ws-a',
        installationId: 10,
        repoFullName: 'org/repo',
        pullNumber: 1,
        headSha: 'sha1',
        status: 'queued',
        costUsd: null,
        detail: null,
      });
      await store.finishReviewRun('ws-a', r1.id, {
        status: 'completed',
        costUsd: 0.50,
        detail: null,
      });
      await client.query("UPDATE review_runs SET created_at = now() - interval '40 days' WHERE id = $1;", [r1.id]);

      // Run 2: Workspace A inside current month ($0.75)
      const r2 = await store.createReviewRun({
        workspaceId: 'ws-a',
        installationId: 10,
        repoFullName: 'org/repo',
        pullNumber: 2,
        headSha: 'sha2',
        status: 'queued',
        costUsd: null,
        detail: null,
      });
      await store.finishReviewRun('ws-a', r2.id, {
        status: 'completed',
        costUsd: 0.75,
        detail: null,
      });

      // Run 3: Workspace B inside current month ($5.00) - must NOT be included in ws-a
      const r3 = await store.createReviewRun({
        workspaceId: 'ws-b',
        installationId: 20,
        repoFullName: 'org/repo-b',
        pullNumber: 3,
        headSha: 'sha3',
        status: 'queued',
        costUsd: null,
        detail: null,
      });
      await store.finishReviewRun('ws-b', r3.id, {
        status: 'completed',
        costUsd: 5.00,
        detail: null,
      });

      // For Workspace A, only r2 ($0.75) is >= monthStart
      const costA = await store.monthCostUsd('ws-a', monthStart);
      expect(costA).toBeCloseTo(0.75, 4);
      expect(typeof costA).toBe('number');

      // For Workspace B, only r3 ($5.00) is included
      const costB = await store.monthCostUsd('ws-b', monthStart);
      expect(costB).toBeCloseTo(5.00, 4);

      // Future month returns 0 for both
      const futureMonth = new Date(now + 10 * 24 * 60 * 60 * 1000);
      const futureCostA = await store.monthCostUsd('ws-a', futureMonth);
      expect(futureCostA).toBe(0);

      // Starting from 60 days ago includes both r1 and r2 ($0.50 + $0.75 = $1.25)
      const olderMonth = new Date(now - 60 * 24 * 60 * 60 * 1000);
      const olderCostA = await store.monthCostUsd('ws-a', olderMonth);
      expect(olderCostA).toBeCloseTo(1.25, 4);
    } finally {
      await close();
    }
  });

  it('maps numeric columns to JS numbers', async () => {
    const { store, close } = await createTestDb();
    try {
      await store.upsertInstallation({
        id: 987654321,
        workspaceId: 'ws-num',
        accountLogin: 'num-login',
        accountType: 'User',
        repositorySelection: 'all',
        suspended: false,
      });

      const inst = await store.getInstallation(987654321);
      expect(typeof inst?.id).toBe('number');
      expect(inst?.id).toBe(987654321);

      await store.saveSettings({
        workspaceId: 'ws-num',
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        language: 'en',
        monthlyBudgetUsd: 25.5,
      });

      const settings = await store.getSettings('ws-num');
      expect(typeof settings?.monthlyBudgetUsd).toBe('number');
      expect(settings?.monthlyBudgetUsd).toBe(25.5);

      const run = await store.createReviewRun({
        workspaceId: 'ws-num',
        installationId: 987654321,
        repoFullName: 'test/repo',
        pullNumber: 42,
        headSha: 'abc',
        status: 'queued',
        costUsd: null,
        detail: null,
      });

      await store.finishReviewRun('ws-num', run.id, {
        status: 'completed',
        costUsd: 0.001234,
        detail: 'done',
      });

      const runs = await store.listReviewRuns('ws-num', 1);
      expect(typeof runs[0].installationId).toBe('number');
      expect(typeof runs[0].pullNumber).toBe('number');
      expect(typeof runs[0].costUsd).toBe('number');
      expect(runs[0].costUsd).toBe(0.001234);
    } finally {
      await close();
    }
  });
});
