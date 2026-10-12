import { describe, expect, it } from 'vitest';
import type {
  AppStore,
  Installation,
  StoredCredential,
  WorkspaceSettings,
} from '../core/types.js';

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

        // Update settings with null budget
        const updated: WorkspaceSettings = {
          ...initial,
          provider: 'openai',
          model: 'gpt-4o',
          language: 'en',
          monthlyBudgetUsd: null,
        };
        await store.saveSettings(updated);

        const reloaded = await store.getSettings('ws-settings-test');
        expect(reloaded?.provider).toBe('openai');
        expect(reloaded?.monthlyBudgetUsd).toBeNull();
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
          provider: 'anthropic',
          ciphertext: 'enc:secret-cipher-text-1',
          keyVersion: 1,
          last4: 'sk-1',
          createdBy: 'user-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
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

        const fetched1 = await store.getCredential('ws-cred-test', 'anthropic');
        expect(fetched1).not.toBeNull();
        expect(fetched1?.ciphertext).toBe('enc:secret-cipher-text-1');
        expect(fetched1?.last4).toBe('sk-1');

        // listCredentials MUST omit ciphertext
        const listed = await store.listCredentials('ws-cred-test');
        expect(listed).toHaveLength(2);
        for (const item of listed) {
          expect(item).not.toHaveProperty('ciphertext');
        }

        // Delete credential
        await store.deleteCredential('ws-cred-test', 'anthropic');
        const deleted = await store.getCredential('ws-cred-test', 'anthropic');
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

    it('deletes workspace data: credentials, settings, review runs, and unlinks installations', async () => {
      const store = await createStore();
      try {
        const wsTarget = 'ws-del-target';
        const wsOther = 'ws-del-other';

        // 1. Settings
        await store.saveSettings({
          workspaceId: wsTarget,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-latest',
          language: 'ar',
          monthlyBudgetUsd: 100,
        });
        await store.saveSettings({
          workspaceId: wsOther,
          provider: 'openai',
          model: 'gpt-4o',
          language: 'en',
          monthlyBudgetUsd: 200,
        });

        // 2. Credentials
        await store.saveCredential({
          id: '11111111-1111-4111-8111-111111111111',
          workspaceId: wsTarget,
          provider: 'anthropic',
          ciphertext: 'enc:secret-target',
          keyVersion: 1,
          last4: 'sk-1',
          createdBy: 'user-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        await store.saveCredential({
          id: '22222222-2222-4222-8222-222222222222',
          workspaceId: wsOther,
          provider: 'openai',
          ciphertext: 'enc:secret-other',
          keyVersion: 1,
          last4: 'sk-2',
          createdBy: 'user-2',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        // 3. Review runs
        await store.createReviewRun({
          workspaceId: wsTarget,
          installationId: 501,
          repoFullName: 'target/repo',
          pullNumber: 1,
          headSha: 'sha-target-1',
          status: 'completed',
          costUsd: 0.1,
          detail: 'Done',
        });
        await store.createReviewRun({
          workspaceId: wsOther,
          installationId: 502,
          repoFullName: 'other/repo',
          pullNumber: 2,
          headSha: 'sha-other-1',
          status: 'completed',
          costUsd: 0.2,
          detail: 'Done',
        });

        // 4. Installations
        await store.upsertInstallation({
          id: 501,
          workspaceId: wsTarget,
          accountLogin: 'target-login',
          accountType: 'Organization',
          repositorySelection: 'all',
          suspended: false,
        });
        await store.upsertInstallation({
          id: 502,
          workspaceId: wsOther,
          accountLogin: 'other-login',
          accountType: 'User',
          repositorySelection: 'all',
          suspended: false,
        });

        // Perform deleteWorkspaceData on wsTarget
        await store.deleteWorkspaceData(wsTarget);

        // Verify wsTarget data is gone
        expect(await store.getSettings(wsTarget)).toBeNull();
        expect(await store.listCredentials(wsTarget)).toEqual([]);
        expect(await store.getCredential(wsTarget, 'anthropic')).toBeNull();
        expect(await store.listReviewRuns(wsTarget, 10)).toEqual([]);

        // Installation 501 is unlinked: not returned for wsTarget, getInstallation returns null (since unlinked)
        expect(await store.listInstallations(wsTarget)).toEqual([]);
        expect(await store.getInstallation(501)).toBeNull();

        // But installation 501 is NOT deleted! It can be linked to wsOther now
        await store.linkInstallation(501, wsOther);
        const relinked = await store.getInstallation(501);
        expect(relinked).not.toBeNull();
        expect(relinked?.workspaceId).toBe(wsOther);

        // Verify wsOther data remains intact
        const otherSettings = await store.getSettings(wsOther);
        expect(otherSettings?.provider).toBe('openai');
        expect(await store.listCredentials(wsOther)).toHaveLength(1);
        expect(await store.listReviewRuns(wsOther, 10)).toHaveLength(1);
        expect(await store.getInstallation(502)).not.toBeNull();
      } finally {
        await cleanup?.();
      }
    });
  });
}
