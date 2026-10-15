import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../core/memory-store.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from './service.js';

const keyA = ['tk', 'rev', 'a', '1111'].join('-');
const keyB = ['tk', 'rev', 'b', '2222'].join('-');

describe('revealRoster', () => {
  it('pairs each secret with last4 from a single list snapshot', async () => {
    const store = new MemoryStore();
    const vault = new EnvelopeVault(Buffer.alloc(32, 9).toString('base64'));
    const service = new CredentialService({ store, vault });
    await service.saveKeyList({ workspaceId: 'ws', provider: 'gemini', apiKeys: [keyA, keyB], userId: 'u' });

    let listCalls = 0;
    const list = store.listProviderKeys.bind(store);
    vi.spyOn(store, 'listProviderKeys').mockImplementation(async (workspaceId, provider) => {
      listCalls += 1;
      const rows = await list(workspaceId, provider);
      if (listCalls > 1) return rows.slice(1);
      return rows;
    });

    const revealed = await service.revealRoster('ws', 'gemini');
    expect(listCalls).toBe(1);
    expect(revealed).toHaveLength(2);
    expect(revealed[0]?.secret.reveal()).toBe(keyA);
    expect(revealed[0]?.last4).toBe(keyA.slice(-4));
    expect(revealed[1]?.secret.reveal()).toBe(keyB);
    expect(revealed[1]?.last4).toBe(keyB.slice(-4));
  });
});
