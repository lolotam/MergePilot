import { describe, expect, it } from 'vitest';
import { LlmFailure, Secret, callWithKeyRotation } from '@mergepilot/engine';
import type { Logger } from 'pino';
import { MemoryStore } from '../core/memory-store.js';
import { CursorWrites, rotationHandler } from '../worker/key-roster.js';
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
    const slots = await store.listProviderKeys('ws', 'openrouter');
    const keyBId = slots.find((slot) => slot.position === outcome.index)?.id;
    expect(keyBId).toBeDefined();
    await service.rememberSuccessfulKey('ws', 'openrouter', keyBId!);
    expect(await store.getKeyCursor('ws', 'openrouter')).toBe(1);
    const next = await service.resolveKeyRoster('ws', 'openrouter');
    expect(next?.startIndex).toBe(1);
    expect(next?.secrets[1]?.reveal()).toBe(keyB);
    expect(next?.secrets[0]?.reveal()).toBe(keyA);
  });

  it('leaves the cursor where it was when every key is quota-exhausted', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'opencode-zen', apiKeys: [keyA, keyB], userId: 'u' });
    const zenSlots = await store.listProviderKeys('ws', 'opencode-zen');
    await service.rememberSuccessfulKey('ws', 'opencode-zen', zenSlots[1]!.id);
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
    const geminiSlots = await store.listProviderKeys('ws', 'gemini');
    await Promise.all(
      [0, 1, 0, 1, 0].map((position) => service.rememberSuccessfulKey('ws', 'gemini', geminiSlots[position]!.id)),
    );
    expect([0, 1]).toContain(await store.getKeyCursor('ws', 'gemini'));
  });

  it('resets the cursor to 0 when provider keys are reordered', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'gemini', apiKeys: [keyA, keyB], userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'gemini');
    const idA = slots[0]!.id;
    const idB = slots[1]!.id;
    await service.rememberSuccessfulKey('ws', 'gemini', idB);
    expect(await store.getKeyCursor('ws', 'gemini')).toBe(1);
    await service.reorderProviderKeys('ws', 'gemini', [idB, idA]);
    expect(await store.getKeyCursor('ws', 'gemini')).toBe(0);
  });

  it('resets the cursor to 0 when a provider key is deleted', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'gemini', apiKeys: [keyA, keyB], userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'gemini');
    const idB = slots[1]!.id;
    await service.rememberSuccessfulKey('ws', 'gemini', idB);
    expect(await store.getKeyCursor('ws', 'gemini')).toBe(1);
    await service.deleteProviderKey('ws', 'gemini', idB);
    expect(await store.getKeyCursor('ws', 'gemini')).toBe(0);
  });

  it('leaves the cursor unchanged when the successful key id no longer exists', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'openrouter', apiKeys: [keyA, keyB], userId: 'u' });
    const slots = await store.listProviderKeys('ws', 'openrouter');
    const idB = slots[1]!.id;
    await service.rememberSuccessfulKey('ws', 'openrouter', idB);
    expect(await store.getKeyCursor('ws', 'openrouter')).toBe(1);
    await service.deleteProviderKey('ws', 'openrouter', idB);
    await service.rememberSuccessfulKey('ws', 'openrouter', idB);
    expect(await store.getKeyCursor('ws', 'openrouter')).toBe(0);
  });

  it('logs the index and never the secret', async () => {
    const { store, service } = fixture();
    await service.saveKeyList({ workspaceId: 'ws', provider: 'gemini', apiKeys: [keyA, keyB], userId: 'u' });
    const geminiSlots = await store.listProviderKeys('ws', 'gemini');
    const lines: unknown[] = [];
    const logger = {
      info: (obj: unknown) => lines.push(obj),
      warn: (obj: unknown) => lines.push(obj),
    } as unknown as Logger;
    const events: Array<{ provider: string; keyIndex: number; skipped: number }> = [];
    const writes = new CursorWrites();
    const handler = rotationHandler(events, service, 'ws', logger, {
      gemini: [geminiSlots[0]!.id, geminiSlots[1]!.id],
    }, writes);
    handler({ provider: 'gemini', index: 1, skipped: 1 });
    await writes.flush();
    // The real CredentialService (private fields) must be called with its receiver and persist the key.
    expect(await store.getKeyCursor('ws', 'gemini')).toBe(1);
    expect(lines.some((line) => (line as { event?: string }).event === 'credential.key_cursor_failed')).toBe(false);
    const dumped = JSON.stringify({ lines, events, secret: new Secret(keyA).toString() });
    expect(dumped).not.toContain(keyA);
    expect(dumped).not.toContain(keyB);
    expect(events).toEqual([{ provider: 'gemini', keyIndex: 1, skipped: 1 }]);
    expect(lines[0]).toMatchObject({ event: 'credential.key_rotation', provider: 'gemini', keyIndex: 1, skipped: 1 });
  });
});
