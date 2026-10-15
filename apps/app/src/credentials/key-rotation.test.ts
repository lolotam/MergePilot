import { describe, expect, it } from 'vitest';
import { LlmFailure, Secret, callWithKeyRotation } from '@mergepilot/engine';
import type { Logger } from 'pino';
import { MemoryStore } from '../core/memory-store.js';
import { rotationHandler } from '../worker/key-roster.js';
import { EnvelopeVault } from '../vault/envelope-vault.js';
import { CredentialService } from './service.js';

const keyA = ['tk', 'rot', 'a', '1111'].join('-');
const keyB = ['tk', 'rot', 'b', '2222'].join('-');

function fixture() {
  const store = new MemoryStore();
  const vault = new EnvelopeVault(Buffer.alloc(32, 4).toString('base64'));
  const service = new CredentialService({ store, vault });
  return { store, service };
}

describe('multi-key roster', () => {
  it('stores every key encrypted, and an auth failure does not move the cursor', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'gemini', apiKeys: [keyA, keyB], userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'gemini');
    expect(slots.map((slot) => slot.position)).toEqual([0, 1]);
    for (const slot of slots) {
      expect(slot.ciphertext.startsWith('v1.')).toBe(true);
      expect(slot.ciphertext).not.toContain(keyA);
      expect(slot.ciphertext).not.toContain(keyB);
    }
    const parent = await store.getCredential('ws', 'gemini');
    expect(parent?.ciphertext).not.toContain(keyA);

    const seen: number[] = [];
    await expect(
      callWithKeyRotation({
        provider: 'gemini',
        keyCount: 2,
        startIndex: 0,
        call: async (index) => {
          seen.push(index);
          throw new LlmFailure({ code: 'INVALID_CREDENTIAL', provider: 'gemini', status: 401, message: `no ${keyA}` });
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    expect(seen).toEqual([0]);
    expect(await store.getKeyCursor('ws', 'gemini')).toBe(0);
  });

  it('moves the stored index to the second key after a quota skip, and the next roster starts there', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'openrouter', apiKeys: [keyA, keyB], userId: 'u' });
    const outcome = await callWithKeyRotation({
      provider: 'openrouter',
      keyCount: 2,
      startIndex: 0,
      call: async (index) => {
        if (index === 0) throw new LlmFailure({ code: 'QUOTA', provider: 'openrouter', status: 429, message: 'over' });
        return 'ok';
      },
    });
    expect(outcome).toEqual({ value: 'ok', index: 1, skipped: 1 });
    await service.rememberSuccessfulKey('ws', 'openrouter', outcome.index);
    expect(await store.getKeyCursor('ws', 'openrouter')).toBe(1);
    const next = await service.resolveKeyRoster('ws', 'openrouter');
    expect(next?.startIndex).toBe(1);
    expect(next?.secrets[1]?.reveal()).toBe(keyB);
    expect(next?.secrets[0]?.reveal()).toBe(keyA);
  });

  it('leaves the cursor where it was when every key is quota-exhausted', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'opencode-zen', apiKeys: [keyA, keyB], userId: 'u' });
    await service.rememberSuccessfulKey('ws', 'opencode-zen', 1);
    await expect(
      callWithKeyRotation({
        provider: 'opencode-zen',
        keyCount: 2,
        startIndex: 1,
        call: async () => {
          throw new LlmFailure({ code: 'QUOTA', provider: 'opencode-zen', status: 429, message: `over ${keyB}` });
        },
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED_ALL_KEYS' });
    expect(await store.getKeyCursor('ws', 'opencode-zen')).toBe(1);
  });

  it('keeps a concurrent cursor inside the stored list', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'gemini', apiKeys: [keyA, keyB], userId: 'u' });
    await Promise.all([0, 1, 0, 1, 0].map((position) => service.rememberSuccessfulKey('ws', 'gemini', position)));
    expect([0, 1]).toContain(await store.getKeyCursor('ws', 'gemini'));
  });

  it('logs the index and never the secret', async () => {
    const { service } = fixture();
    const lines: unknown[] = [];
    const logger = {
      info: (obj: unknown) => lines.push(obj),
      warn: (obj: unknown) => lines.push(obj),
    } as unknown as Logger;
    const events: Array<{ provider: string; keyIndex: number; skipped: number }> = [];
    const handler = rotationHandler(events, service, 'ws', logger);
    handler({ provider: 'gemini', index: 1, skipped: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dumped = JSON.stringify({ lines, events, secret: new Secret(keyA).toString() });
    expect(dumped).not.toContain(keyA);
    expect(dumped).not.toContain(keyB);
    expect(events).toEqual([{ provider: 'gemini', keyIndex: 1, skipped: 1 }]);
    expect(lines[0]).toMatchObject({ event: 'credential.key_rotation', provider: 'gemini', keyIndex: 1, skipped: 1 });
  });
});
