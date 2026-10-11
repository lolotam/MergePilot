import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { CredentialService } from '../../src/credentials/service.js';
import { EnvelopeVault } from '../../src/vault/envelope-vault.js';
import {
  createMigratedTestDb,
  hasIntegrationEnv,
  INTEGRATION_DATABASE_URL,
} from './test-helper.js';

describe.skipIf(!hasIntegrationEnv)('vault + credentials integration on real Postgres', () => {
  it('saves key through CredentialService, verifies ciphertext in raw row, resolves key, and isolates workspaces', async () => {
    const ctx = await createMigratedTestDb(INTEGRATION_DATABASE_URL);
    try {
      const masterKey = randomBytes(32).toString('base64');
      const vault = new EnvelopeVault(masterKey);
      const fakeValidator = vi.fn().mockResolvedValue(true);
      const service = new CredentialService({
        store: ctx.store,
        vault,
        validate: fakeValidator,
      });

      const rawApiKey = 'sk-ant-test-real-integration-key-998877';
      const saved = await service.saveKey({
        workspaceId: 'ws-cred-alpha',
        provider: 'anthropic',
        apiKey: rawApiKey,
        userId: 'user-integration-test',
      });

      expect(saved.last4).toBe('8877');
      expect(saved.provider).toBe('anthropic');
      expect(saved.workspaceId).toBe('ws-cred-alpha');
      expect(fakeValidator).toHaveBeenCalledWith('anthropic', rawApiKey);

      // Raw SQL query directly on PostgreSQL table
      const rawRes = await ctx.pool.query<{
        id: string;
        workspace_id: string;
        provider: string;
        ciphertext: string;
        last4: string;
        key_version: number;
      }>(
        'SELECT id, workspace_id, provider, ciphertext, last4, key_version FROM provider_credentials WHERE workspace_id = $1 AND provider = $2;',
        ['ws-cred-alpha', 'anthropic'],
      );

      expect(rawRes.rows).toHaveLength(1);
      const row = rawRes.rows[0];
      expect(row.last4).toBe('8877');
      expect(row.key_version).toBe(1);

      // Raw row holds ciphertext, NOT plaintext
      expect(row.ciphertext).toBeDefined();
      expect(row.ciphertext.startsWith('v1.')).toBe(true);
      expect(row.ciphertext).not.toContain(rawApiKey);
      expect(row.ciphertext).not.toContain('998877');
      expect(JSON.stringify(row)).not.toContain(rawApiKey);

      // Resolve returns the secret key
      const resolved = await service.resolve('ws-cred-alpha', 'anthropic');
      expect(resolved).toBeInstanceOf(Secret);
      expect(resolved.reveal()).toBe(rawApiKey);

      // A different workspace cannot resolve this key
      await expect(service.resolve('ws-cred-bravo', 'anthropic')).rejects.toThrow();

      // No rows exist for the other workspace
      const bravoRes = await ctx.pool.query(
        'SELECT * FROM provider_credentials WHERE workspace_id = $1;',
        ['ws-cred-bravo'],
      );
      expect(bravoRes.rows).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });
});
