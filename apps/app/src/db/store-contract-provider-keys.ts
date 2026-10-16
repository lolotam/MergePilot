import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AppStore, KeyProvider, StoredProviderKey } from '../core/types.js';

export function defineProviderKeyCursorContract(
  createStore: () => Promise<AppStore> | AppStore,
  cleanup?: () => Promise<void> | void,
): void {
  describe('provider key cursor by id', () => {
    const workspaceId = 'ws-cred-test';
    const provider: KeyProvider = 'gemini';

    function slot(id: string, position: number, last4: string): StoredProviderKey {
      return {
        id,
        workspaceId,
        provider,
        position,
        ciphertext: `cipher-${id}`,
        keyVersion: 1,
        last4,
        createdBy: 'u',
        createdAt: new Date(),
        lastTestStatus: null,
        lastTestedAt: null,
      };
    }

    it('stores the current index of a key id and ignores missing ids', async () => {
      const store = await createStore();
      try {
        const idA = randomUUID();
        const idB = randomUUID();
        await store.modifyProviderKeys(workspaceId, provider, async (_current, _parent) => ({
          keys: [slot(idA, 0, 'aaa1'), slot(idB, 1, 'bbb2')],
          cursor: 0,
        }));
        await store.setKeyCursor(workspaceId, provider, idB);
        expect(await store.getKeyCursor(workspaceId, provider)).toBe(1);
        await store.modifyProviderKeys(workspaceId, provider, async (current, _parent) => {
          const byId = new Map(current.map((row) => [row.id, row]));
          return {
            keys: [idB, idA].map((id, position) => ({ ...byId.get(id)!, position })),
          };
        });
        await store.setKeyCursor(workspaceId, provider, idB);
        expect(await store.getKeyCursor(workspaceId, provider)).toBe(0);
        await store.setKeyCursor(workspaceId, provider, randomUUID());
        expect(await store.getKeyCursor(workspaceId, provider)).toBe(0);
      } finally {
        await cleanup?.();
      }
    });
  });
}
