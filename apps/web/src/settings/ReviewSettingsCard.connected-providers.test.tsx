import { waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiProvider } from '../api/client.js';
import { ToastProvider } from '../components/Toast.js';
import { MAIN_SETTINGS } from './bots/bots-test-utils.js';
import { SAAS_PROVIDERS } from './providers.js';
import { ReviewSettingsCard } from './ReviewSettingsCard.js';
import { renderSettings } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, fetchApi: vi.fn(), api: { ...actual.api, getModels: vi.fn(), getSubscriptionAvailability: vi.fn() } };
});

// The saved fallback also uses the "AI Provider" label; the main bot's select has a stable id.
const providerSelect = () => document.getElementById('settings-provider') as HTMLSelectElement;
const optionValues = () => within(providerSelect()).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);

function card(keyedProviders: readonly ApiProvider[] | undefined, provider: ApiProvider = 'openrouter') {
  return (
    <ToastProvider>
      <ReviewSettingsCard
        workspaceId="ws-1"
        settings={{ ...MAIN_SETTINGS, provider }}
        isLoading={false}
        isMember={false}
        onSave={vi.fn(async () => undefined)}
        isSaving={false}
        keyedProviders={keyedProviders}
      />
    </ToastProvider>
  );
}

describe('the main bot provider list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue({ models: [] });
    // The server offers the subscription-only provider, so "all" means every SaaS provider.
    vi.mocked(api.getSubscriptionAvailability).mockResolvedValue({ providers: ['google-antigravity'] });
  });

  it('lists only the connected providers when the saved provider is one of them', async () => {
    renderSettings(card(['openrouter']), 'en');

    await waitFor(() => expect(optionValues()).toEqual(['openrouter']));
  });

  it('keeps a saved provider with no key first, then lists the connected ones', async () => {
    renderSettings(card(['openrouter'], 'anthropic'), 'en');

    await waitFor(() => expect(optionValues()).toEqual(['anthropic', 'openrouter']));
  });

  it('lists every SaaS provider while the connected list is unknown', async () => {
    renderSettings(card(undefined), 'en');

    await waitFor(() => expect(optionValues()).toEqual(SAAS_PROVIDERS));
  });
});
