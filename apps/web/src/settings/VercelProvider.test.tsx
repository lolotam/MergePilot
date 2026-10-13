import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api/client.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
import { ReviewSettingsCard } from './ReviewSettingsCard.js';
import { isJudgeKeyOnly, KEY_PROVIDERS, SAAS_PROVIDERS } from './providers.js';
import { renderSettings, typedKey } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    api: { ...actual.api, getModels: vi.fn(), testConnection: vi.fn(), testModelsUnsaved: vi.fn(), testJudge: vi.fn() },
  };
});

const VERCEL_MODELS = {
  models: [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', efforts: ['off', 'low', 'medium', 'high'] },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', efforts: [] },
  ],
};

describe('Vercel AI Gateway as a review provider', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue(VERCEL_MODELS);
  });

  it('is a review provider, saved once as a key, and no longer a Jev-only key type', () => {
    expect(SAAS_PROVIDERS).toContain('vercel-gateway');
    expect(KEY_PROVIDERS.filter((p) => p === 'vercel-gateway')).toHaveLength(1);
    expect(isJudgeKeyOnly('vercel-gateway')).toBe(false);
    expect(isJudgeKeyOnly('typesafe')).toBe(true);
  });

  it('appears in the review provider select and lists its full model catalog', async () => {
    const onSave = vi.fn(async () => undefined);
    renderSettings(
      <ReviewSettingsCard
        workspaceId="ws-1"
        settings={{ provider: 'vercel-gateway', model: '', language: 'en', effort: null, fallback: [], minSeverity: 'medium' }}
        isLoading={false}
        isMember={false}
        onSave={onSave}
        isSaving={false}
        keyedProviders={['vercel-gateway']}
      />,
      'en',
    );
    const select = screen.getByRole('combobox', { name: 'AI Provider' }) as HTMLSelectElement;
    expect(select.value).toBe('vercel-gateway');
    const option = within(select).getByRole('option', { name: 'Vercel AI Gateway' }) as HTMLOptionElement;
    expect(option.value).toBe('vercel-gateway');

    await user.click(await screen.findByRole('button', { name: 'Model name' }));
    expect(screen.getByRole('option', { name: /GPT-4o mini/ })).toBeDefined();
    await user.click(screen.getByRole('option', { name: /Claude Sonnet 4\.5/ }));
    expect(api.getModels).toHaveBeenCalledWith('ws-1', 'vercel-gateway');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ provider: 'vercel-gateway', model: 'anthropic/claude-sonnet-4.5' }));
  });

  it('tests an unsaved Vercel key as a review key, not with a judge question', async () => {
    vi.mocked(api.testConnection).mockResolvedValueOnce({ ok: true, ms: 21, model: 'anthropic/claude-sonnet-4.5' });
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws-1" />, 'en');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'vercel-gateway');
    await user.type(screen.getByLabelText('Secret API Key'), typedKey());
    await user.click(screen.getByRole('button', { name: 'Test before saving' }));
    await waitFor(() =>
      expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'vercel-gateway', { apiKey: typedKey(), baseUrl: undefined, model: undefined }),
    );
    expect(api.testJudge).not.toHaveBeenCalled();
  });
});
