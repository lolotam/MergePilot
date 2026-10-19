import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { Secret } from '@mergepilot/engine';
import type { WorkspaceSettings } from '../core/types.js';
import { workspaceJudge } from './judge-setup.js';
import type { ProcessReviewCredentials } from './types.js';

describe('workspaceJudge', () => {
  it.each(['subscription', null] as const)('skips an unavailable subscription without refreshing when its effective method is %s', async (effective) => {
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(async () => { throw new Error('Refused subscription must not be resolved again'); }),
      getEffectiveAuthMethod: vi.fn(async () => effective),
      resolveKeyRoster: vi.fn(async () => null),
    };
    const settings = {
      judge: { enabled: true, provider: 'anthropic', model: 'jev-latest', fallback: [], uses: [], threshold: 0.5 },
    } as unknown as WorkspaceSettings;
    const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
    const setup = await workspaceJudge(settings, 'ws-1', credentials, logger, {
      jobId: 'job', runId: 'run', unavailableSubscriptions: new Set(['anthropic']),
    });

    expect(setup.judge).toBeDefined();
    expect(setup.secrets).toEqual([]);
    expect(credentials.resolve).not.toHaveBeenCalled();
    if (effective === 'subscription') expect(credentials.resolveKeyRoster).not.toHaveBeenCalled();
  });

  it('still loads the API-key judge roster for a provider with an unavailable subscription', async () => {
    const apiKey = new Secret('anthropic-judge-api-key');
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(),
      getEffectiveAuthMethod: vi.fn(async () => 'api-key'),
      resolveKeyRoster: vi.fn(async () => ({ secrets: [apiKey], keyIds: ['judge-key'], startIndex: 0 })),
    };
    const settings = {
      judge: { enabled: true, provider: 'anthropic', model: 'jev-latest', fallback: [], uses: [], threshold: 0.5 },
    } as unknown as WorkspaceSettings;
    const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
    const setup = await workspaceJudge(settings, 'ws-1', credentials, logger, {
      jobId: 'job', runId: 'run', unavailableSubscriptions: new Set(['anthropic']),
    });

    expect(setup.secrets).toEqual([apiKey]);
    expect(credentials.resolveKeyRoster).toHaveBeenCalledOnce();
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('falls back to the single credential when the key roster cannot be loaded', async () => {
    const single = new Secret('openrouter-single-key-value');
    const warn = vi.fn();
    const logger = { warn, info: vi.fn() } as unknown as Logger;
    const credentials: ProcessReviewCredentials = {
      resolve: vi.fn(async () => single),
      resolveKeyRoster: vi.fn(async () => {
        throw new Error('openrouter-unreadable-second-key');
      }),
    };
    const settings = {
      judge: { enabled: true, provider: 'openrouter', model: 'some/model', fallback: [], uses: ['review'], threshold: 0.5 },
    } as unknown as WorkspaceSettings;

    const setup = await workspaceJudge(settings, 'ws-1', credentials, logger, { jobId: 'job', runId: 'run' });

    expect(setup.secrets).toEqual([single]);
    expect(setup.judge).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ event: 'credential.key_roster_failed', provider: 'openrouter', error: 'Error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('unreadable-second-key');
  });
});
