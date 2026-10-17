import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_MAX_BYTES } from './contract-backup.js';
import {
  createBackupHarness,
  exportBackup,
  PASSPHRASE,
  restoreBackup,
  seedWorkspace,
  type BackupHarness,
} from './backup-routes.fixtures.js';

type BackupFileJson = Record<string, unknown> & {
  settings: Record<string, unknown>;
  bots: Array<Record<string, unknown>>;
  credentials: Array<Record<string, unknown> & { provider: string; key?: Record<string, string> }>;
};

describe('settings restore validation (ADR-0018)', { timeout: 60000 }, () => {
  let h: BackupHarness;
  let file: BackupFileJson;

  beforeAll(async () => {
    h = await createBackupHarness();
    await seedWorkspace(h);
    file = (await exportBackup(h, { includeKeys: true, passphrase: PASSPHRASE })).json();
  }, 60000);

  afterAll(async () => {
    await h.close();
  });

  const copy = (): BackupFileJson => structuredClone(file);
  const index = (provider: string) => file.credentials.findIndex((c) => c.provider === provider);
  /** [status, code, field] of a restore into the empty ws-2. */
  const refusal = async (body: Record<string, unknown>) => {
    const res = await restoreBackup(h, { passphrase: PASSPHRASE, ...body });
    const error = res.json().error ?? {};
    return [res.statusCode, error.code, error.field];
  };
  const expectWs2Untouched = async () => {
    expect(await h.store.getSettings('ws-2')).toBeNull();
    expect(await h.store.listReviewerBots('ws-2')).toEqual([]);
    expect(await h.store.listCredentials('ws-2')).toEqual([]);
  };

  it('a wrong passphrase or a changed ciphertext answers bad_passphrase with no detail', async () => {
    const wrong = await restoreBackup(h, { file, passphrase: 'not the right passphrase' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual({ error: { code: 'bad_passphrase', message: 'Wrong passphrase, or the file was changed' } });

    const tampered = copy();
    const sealed = tampered.credentials[0]?.key as Record<string, string>;
    const ct = Buffer.from(sealed.ct ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    sealed.ct = ct.toString('base64url');
    expect(await refusal({ file: tampered })).toEqual([400, 'bad_passphrase', undefined]);

    // A key moved to another provider no longer opens either (it is bound to its provider).
    const moved = copy();
    const [first, second] = moved.credentials;
    if (first && second) [first.key, second.key] = [second.key, first.key];
    expect(await refusal({ file: moved })).toEqual([400, 'bad_passphrase', undefined]);
    expect(await refusal({ file, passphrase: undefined })).toEqual([400, 'passphrase_required', 'passphrase']);
    await expectWs2Untouched();
  });

  it('checks the format, version and size of the file', async () => {
    expect(await refusal({ file: { ...file, format: 'something-else' } })).toEqual([400, 'invalid_backup_format', 'format']);
    expect(await refusal({ file: 'not json object' })).toEqual([400, 'invalid_backup_format', 'format']);
    expect(await refusal({ file: { ...file, version: 2 } })).toEqual([400, 'unsupported_backup_version', 'version']);
    expect(await refusal({ file: { ...file, bots: 'none' } })).toEqual([400, 'validation_error', 'bots']);

    const big = await restoreBackup(h, { file: { ...file, padding: 'x'.repeat(BACKUP_MAX_BYTES) }, passphrase: PASSPHRASE });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('file_too_large');
    await expectWs2Untouched();
  });

  it('runs the settings through the same checks as PUT /settings, naming the field', async () => {
    const withSettings = (patch: Record<string, unknown>) => ({ ...copy(), settings: { ...file.settings, ...patch } });
    expect(await refusal({ file: withSettings({ provider: 'not-a-provider' }) })).toEqual([400, 'validation_error', 'settings.provider']);
    expect(await refusal({ file: withSettings({ model: '   ' }) })).toEqual([400, 'validation_error', 'settings.model']);
    expect(await refusal({ file: withSettings({ fallback: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }] }) })).toEqual([
      400,
      'fallback_duplicate',
      'settings.fallback',
    ]);
    const judge = { ...(file.settings.judge as Record<string, unknown>), model: 'gpt-5' };
    expect(await refusal({ file: withSettings({ judge }) })).toEqual([400, 'judge_model_invalid', 'settings.judge']);
    expect(await refusal({ file: withSettings({ botName: 'x'.repeat(41) }) })).toEqual([400, 'validation_error', 'settings.botName']);

    // Without the keys in this request, the heavy model has no key in ws-2.
    expect(await refusal({ file, sections: ['settings'] })).toEqual([400, 'heavy_key_missing', 'settings.heavyProvider']);
    await expectWs2Untouched();
  });

  it('runs each bot through the same checks as PUT /bots/:slot', async () => {
    const withBot = (patch: Record<string, unknown>, at = 0) => {
      const next = copy();
      next.bots[at] = { ...next.bots[at], ...patch };
      return next;
    };
    expect(await refusal({ file: withBot({ slot: 1 }) })).toEqual([400, 'invalid_slot', 'bots[0].slot']);
    expect(await refusal({ file: withBot({ slot: 4 }) })).toEqual([400, 'invalid_slot', 'bots[1].slot']);
    expect(await refusal({ file: withBot({ logo: 'unicorn' }) })).toEqual([400, 'validation_error', 'bots[0].logo']);
    expect(await refusal({ file: withBot({ name: '  ' }) })).toEqual([400, 'validation_error', 'bots[0].name']);
    expect(await refusal({ file: withBot({ provider: 'nope' }, 1) })).toEqual([400, 'validation_error', 'bots[1].provider']);
    expect(await refusal({ file: withBot({ name: 'owl' }, 1) })).toEqual([409, 'bot_name_taken', 'bots[1].name']);
    expect(await refusal({ file: withBot({ name: 'PILOT PRIME' }) })).toEqual([409, 'bot_name_taken', 'bots[0].name']);
    expect(await refusal({ file: withBot({ fallback: [{ provider: 'gemini', model: 'g' }] }) })).toEqual([
      400,
      'fallback_key_missing',
      'bots[0].fallback',
    ]);
    await expectWs2Untouched();
  });

  it('applies the key route rules to every credential, including the custom base URL guard', async () => {
    const withCredential = (provider: string, patch: Record<string, unknown>) => {
      const next = copy();
      next.credentials[index(provider)] = { ...next.credentials[index(provider)], ...patch } as BackupFileJson['credentials'][number];
      return next;
    };
    const at = (provider: string) => `credentials[${index(provider)}]`;
    expect(await refusal({ file: withCredential('anthropic', { provider: 'made-up' }) })).toEqual([
      400,
      'validation_error',
      `${at('anthropic')}.provider`,
    ]);
    expect(await refusal({ file: withCredential('anthropic', { baseUrl: 'https://x.example.com' }) })).toEqual([
      400,
      'base_url_not_allowed',
      `${at('anthropic')}.baseUrl`,
    ]);
    expect(await refusal({ file: withCredential('custom', { baseUrl: null }) })).toEqual([
      400,
      'custom_base_url_required',
      `${at('custom')}.baseUrl`,
    ]);
    // A changed URL breaks the seal (it is bound to the key)...
    expect(await refusal({ file: withCredential('custom', { baseUrl: 'http://169.254.169.254' }) })).toEqual([400, 'bad_passphrase', undefined]);
    // ...and the stored URL still goes through the SSRF guard (here its host now resolves privately).
    h.dns.address = '10.0.0.8';
    try {
      expect(await refusal({ file })).toEqual([400, 'ssrf_validation_error', `${at('custom')}.baseUrl`]);
    } finally {
      h.dns.address = '93.184.216.34';
    }
    await expectWs2Untouched();
  });

  it('refuses a bad export request and bad restore options', async () => {
    const codeOf = async (body: Record<string, unknown>) => (await exportBackup(h, body)).json().error?.code;
    expect(await codeOf({ includeKeys: true })).toBe('passphrase_required');
    expect(await codeOf({ includeKeys: true, passphrase: 'short-one' })).toBe('passphrase_too_short');
    expect(await codeOf({ passphrase: PASSPHRASE })).toBe('validation_error');
    expect((await exportBackup(h, { includeKeys: false, passphrase: 'short' })).statusCode).toBe(200);
    expect(await refusal({ file, sections: [] })).toEqual([400, 'validation_error', undefined]);
    expect(await refusal({ file, sections: ['runs'] })).toEqual([400, 'validation_error', undefined]);
    await expectWs2Untouched();
  });
});
