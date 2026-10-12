import { expect, it } from 'vitest';
import { WorkspaceDeletedError, type AppStore } from '../core/types.js';

/** deleteWorkspace part of the shared AppStore contract (called from describeStoreContract). */
export function defineDeleteWorkspaceContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
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
        ciphertext: 'enc:tgt',
        keyVersion: 1,
        last4: '0001',
        createdBy: 'user-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      await store.saveCredential({
        id: '22222222-2222-4222-8222-222222222222',
        workspaceId: wsOther,
        provider: 'openai',
        ciphertext: 'enc:oth',
        keyVersion: 1,
        last4: '0002',
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

      await store.deleteWorkspace(wsTarget);

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

      // A worker that read the workspace before deletion cannot record a run afterwards
      await expect(
        store.createReviewRun({
          workspaceId: wsTarget,
          installationId: 501,
          repoFullName: 'target/repo',
          pullNumber: 3,
          headSha: 'sha-late',
          status: 'running',
          costUsd: null,
          detail: null,
        }),
      ).rejects.toBeInstanceOf(WorkspaceDeletedError);
      expect(await store.listReviewRuns(wsTarget, 10)).toEqual([]);

      // Nor can any other late writer (dashboard request, key rotation) recreate its data
      await expect(
        store.saveSettings({
          workspaceId: wsTarget,
          provider: 'anthropic',
          model: 'm',
          language: 'en',
          monthlyBudgetUsd: null,
        }),
      ).rejects.toBeInstanceOf(WorkspaceDeletedError);
      await expect(
        store.saveCredential({
          id: '33333333-3333-4333-8333-333333333333',
          workspaceId: wsTarget,
          provider: 'gemini',
          ciphertext: 'enc:late',
          keyVersion: 1,
          last4: '0003',
          createdBy: 'user-1',
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(WorkspaceDeletedError);
      await store.upsertPendingInstallation({
        id: 503,
        accountLogin: 'late-login',
        accountType: 'User',
        repositorySelection: 'all',
        suspended: false,
      });
      await expect(store.linkInstallation(503, wsTarget)).rejects.toBeInstanceOf(
        WorkspaceDeletedError,
      );
      expect(await store.getSettings(wsTarget)).toBeNull();
      expect(await store.listCredentials(wsTarget)).toEqual([]);
      expect(await store.getInstallation(503)).toBeNull();
    } finally {
      await cleanup?.();
    }
  });
}
