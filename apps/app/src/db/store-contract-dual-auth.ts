import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppStore, KeyProvider, StoredCredential, StoredProviderKey } from '../core/types.js';

export function defineDualAuthStoreContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  describe('dual-method auth preferences (ADR-0027)', () => {
    const workspaceId = 'ws-cred-test';
    const provider: KeyProvider = 'openai';

    function parent(): StoredCredential {
      return {
        id: randomUUID(),
        workspaceId,
        provider,
        ciphertext: 'cipher-sub',
        keyVersion: 1,
        last4: 'sub1',
        createdBy: 'u',
        createdAt: new Date(),
        baseUrl: null,
      };
    }

    function slot(position: number): StoredProviderKey {
      return {
        id: randomUUID(),
        workspaceId,
        provider,
        position,
        ciphertext: `cipher-${position}`,
        keyVersion: 1,
        last4: `k${position}`,
        createdBy: 'u',
        createdAt: new Date(),
        lastTestStatus: null,
        lastTestedAt: null,
      };
    }

    it('passes the parent into modifyProviderKeys and keeps it across slot writes', async () => {
      const store = await createStore();
      try {
        const sub = parent();
        await store.modifyProviderKeys(workspaceId, provider, async (_current, p) => {
          expect(p).toBeNull();
          return { keys: [], parent: sub };
        });
        await store.modifyProviderKeys(workspaceId, provider, async (current, p) => {
          expect(p?.id).toBe(sub.id);
          return { keys: [...current, slot(0)] };
        });
        expect((await store.getCredential(workspaceId, provider))?.id).toBe(sub.id);
      } finally {
        await cleanup?.();
      }
    });

    it('persists authPreference in the same modifyProviderKeys change as slot writes', async () => {
      const store = await createStore();
      try {
        await store.modifyProviderKeys(workspaceId, provider, async () => ({
          keys: [slot(0)],
          parent: parent(),
          authPreference: 'api-key',
        }));
        expect(await store.getProviderAuthPreference(workspaceId, provider)).toBe('api-key');
      } finally {
        await cleanup?.();
      }
    });

    it('aborts modifyProviderKeys before commit when the signal is aborted', async () => {
      const store = await createStore();
      try {
        const controller = new AbortController();
        await expect(
          store.modifyProviderKeys(
            workspaceId,
            provider,
            async () => {
              controller.abort();
              return { keys: [slot(0)], parent: parent(), authPreference: 'subscription' };
            },
            controller.signal,
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(await store.listProviderKeys(workspaceId, provider)).toHaveLength(0);
        expect(await store.getProviderAuthPreference(workspaceId, provider)).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it('rolls back modifyProviderKeys when the signal aborts after the change returns', async () => {
      const store = await createStore();
      try {
        const controller = new AbortController();
        await expect(
          store.modifyProviderKeys(
            workspaceId,
            provider,
            async () => {
              const result = { keys: [slot(0)], parent: parent(), authPreference: 'api-key' as const };
              queueMicrotask(() => controller.abort());
              return result;
            },
            controller.signal,
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(await store.listProviderKeys(workspaceId, provider)).toHaveLength(0);
        expect(await store.getProviderAuthPreference(workspaceId, provider)).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it('deletes preferences with the workspace after they were stored', async () => {
      const store = await createStore();
      try {
        await store.setProviderAuthPreference(workspaceId, provider, 'subscription');
        expect(await store.getProviderAuthPreference(workspaceId, provider)).toBe('subscription');
        await store.deleteWorkspace(workspaceId);
        expect(await store.getProviderAuthPreference(workspaceId, provider)).toBeNull();
      } finally {
        await cleanup?.();
      }
    });
  });
}
