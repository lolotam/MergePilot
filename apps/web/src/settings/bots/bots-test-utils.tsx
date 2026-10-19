import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Settings, SettingsUpdate } from '@mergepilot/app/contract';
import type { BotsResponse, ReviewerBotDto } from '../../api/bots.js';
import type { SkillSummary } from '../../api/skills.js';
import { ApiClientError, fetchApi, type ApiProvider } from '../../api/client.js';
import { ToastProvider } from '../../components/Toast.js';
import { I18nProvider } from '../../i18n/context.js';
import { ReviewerPanel } from './ReviewerPanel.js';

// Test-only helpers for the reviewer panel tests (the caller mocks fetchApi and api.getModels).

export const MAIN_SETTINGS: Settings = {
  provider: 'openrouter',
  model: 'main/model',
  language: 'en',
  effort: 'high',
  fallback: [{ provider: 'openrouter', model: 'fb/one', effort: null }],
  minSeverity: 'medium',
  botName: 'MergePilot',
  botLogo: 'pilot',
  panelMode: 'separate',
  panelMinAgreement: 1,
};

export const CATALOG = {
  models: [
    { id: 'main/model', name: 'Main Model', efforts: ['low', 'high'] },
    { id: 'other/model', name: 'Other Model', efforts: [] },
    { id: 'fb/one', name: 'Fallback One', efforts: [] },
  ],
};

export function extraBot(slot: number, overrides: Partial<ReviewerBotDto> = {}): ReviewerBotDto {
  return {
    slot,
    name: `Extra ${slot}`,
    logo: 'owl',
    active: false,
    provider: 'openrouter',
    model: 'other/model',
    effort: null,
    fallback: [],
    ...overrides,
  };
}

export interface FakeCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Makes the mocked fetchApi answer like the server: GET/PUT settings, GET bots, PUT/DELETE
 * bots/:slot, GET skills. A PUT naming `takenName` answers 409 `bot_name_taken`. Returns the recorded calls.
 */
export function fakeBotsServer(
  options: { settings?: Settings; bots?: ReviewerBotDto[]; takenName?: string; skills?: SkillSummary[] } = {},
) {
  const state = { settings: { ...MAIN_SETTINGS, ...options.settings }, bots: [...(options.bots ?? [])] };
  const calls: FakeCall[] = [];
  vi.mocked(fetchApi).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    if (path.endsWith('/skills')) {
      return { skills: options.skills ?? [], limits: { maxSkills: 50, maxTokens: 8000, maxNameLength: 60 } };
    }
    if (path.endsWith('/settings')) {
      if (method === 'PUT') {
        const { base: _base, ...patch } = body ?? {};
        state.settings = { ...state.settings, ...patch };
      }
      return { settings: state.settings };
    }
    const slotMatch = /\/bots\/(\d)$/.exec(path);
    if (slotMatch) {
      const slot = Number(slotMatch[1]);
      if (method === 'DELETE') {
        state.bots = state.bots.filter((b) => b.slot !== slot);
        return undefined;
      }
      if (options.takenName && body?.['name'] === options.takenName) {
        throw new ApiClientError('Another bot in this workspace already has this name', 'bot_name_taken', 409);
      }
      const bot = { ...(body as unknown as ReviewerBotDto), slot, effort: (body?.['effort'] as string | null) ?? null };
      state.bots = [...state.bots.filter((b) => b.slot !== slot), bot].sort((a, b) => a.slot - b.slot);
      return { bot };
    }
    if (path.endsWith('/bots')) {
      const response: BotsResponse = {
        main: {
          slot: 1,
          name: state.settings.botName ?? 'MergePilot',
          logo: state.settings.botLogo ?? 'pilot',
          active: true,
          provider: state.settings.provider,
          model: state.settings.model,
          effort: state.settings.effort ?? null,
          fallback: state.settings.fallback ?? [],
        },
        bots: state.bots,
        panel: { mode: state.settings.panelMode ?? 'separate', minAgreement: state.settings.panelMinAgreement ?? 1 },
        logos: ['pilot', 'owl', 'fox', 'robot', 'rocket', 'shield', 'bolt', 'eye', 'brain', 'star', 'leaf', 'wave'],
      };
      return response;
    }
    return {};
  });
  return { calls, writes: () => calls.filter((c) => c.method !== 'GET'), state };
}

export function renderPanel(options: {
  isMember?: boolean;
  onSave?: (settings: SettingsUpdate) => Promise<void>;
  keyedProviders?: readonly ApiProvider[] | undefined;
  settings?: Settings;
} = {}) {
  const settings = options.settings ?? MAIN_SETTINGS;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['workspaces', 'ws-1', 'settings'], { settings });
  const onSave = options.onSave ?? vi.fn(async () => undefined);
  const tree = (settings: Settings) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <ToastProvider>
          <ReviewerPanel
            workspaceId="ws-1"
            settings={settings}
            isLoading={false}
            isMember={options.isMember ?? false}
            onSave={onSave}
            isSaving={false}
            keyedProviders={'keyedProviders' in options ? options.keyedProviders : ['openrouter']}
          />
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const utils = render(tree(settings));
  /** Re-renders with the settings a refetch would bring. */
  const rerenderSettings = (next: Settings) => utils.rerender(tree(next));
  return { ...utils, onSave, client, rerenderSettings };
}
