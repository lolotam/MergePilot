import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { refreshCredentialQueries } from '../api/credential-queries.js';
import { SettingsPage } from './SettingsPage.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from '../components/Toast.js';
import { api, type KeyItem, type ModelsResponse } from '../api/client.js';
import { ModelSelect } from '../settings/ModelSelect.js';
import { SyncModels } from '../settings/SyncModels.js';
import { renderSettings } from '../settings/settings.fixtures.js';
import * as hooks from '../api/hooks.js';

function liveResponse(): ModelsResponse {
  return { source: 'live', models: [{ id: 'new-model', name: 'New model', efforts: [] }] };
}

function pendingCatalog() {
  let resolve!: (value: ModelsResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ModelsResponse>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('Sync models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.syncModels).mockReset();
  });

  it('syncs unique connected providers two at a time and updates pickers only for returned catalogs', async () => {
    const user = userEvent.setup();
    const openai = pendingCatalog();
    const anthropic = pendingCatalog();
    vi.mocked(api.syncModels)
      .mockReturnValueOnce(openai.promise)
      .mockReturnValueOnce(anthropic.promise)
      .mockResolvedValueOnce({ source: 'bundled', models: [] });
    const select = vi.fn();
    renderSettings(<>
      <SyncModels workspaceId="ws-1" providers={['openai', 'anthropic', 'openai', 'xai', 'typesafe']} />
      <ModelSelect workspaceId="ws-1" provider="openai" id="openai-model" label="OpenAI picker" value="saved-id" onChange={select} />
      <ModelSelect workspaceId="ws-1" provider="anthropic" id="anthropic-model" label="Anthropic picker" value="claude-3-7-sonnet" onChange={select} />
    </>, 'en');
    await screen.findByText('Claude 3.7 Sonnet');
    const button = screen.getByRole('button', { name: 'Sync all models' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(api.syncModels).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Queued')).toBeDefined();
    await act(async () => anthropic.reject(new Error('private upstream details')));
    await screen.findByText(/Bundled catalog · 0 models/);
    expect(vi.mocked(api.syncModels).mock.calls.map(([workspaceId, provider]) => [workspaceId, provider])).toEqual([
      ['ws-1', 'openai'], ['ws-1', 'anthropic'], ['ws-1', 'xai'],
    ]);
    await act(async () => openai.resolve(liveResponse()));
    expect(screen.getByText('Live catalog · 1 models returned')).toBeDefined();
    expect(screen.getAllByText(/Last live sync this session/)).toHaveLength(1);
    expect(screen.getByText(/Catalog sync failed/)).toBeDefined();
    expect(screen.queryByText('private upstream details')).toBeNull();
    expect(screen.getByText(/Judge-only credential/)).toBeDefined();
    expect(screen.getByText('Claude 3.7 Sonnet')).toBeDefined();
    expect(screen.getByText('saved-id')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'OpenAI picker' }));
    expect(screen.getByRole('option', { name: 'New model' })).toBeDefined();
    expect(select).not.toHaveBeenCalled();
    expect(api.getModels).toHaveBeenCalledTimes(2);
    expect(api.testConnection).not.toHaveBeenCalled();
  });

  it('discards cancellations and late results after switching workspaces or unmounting', async () => {
    const user = userEvent.setup();
    const cancelled = pendingCatalog();
    const switched = pendingCatalog();
    const unmounted = pendingCatalog();
    vi.mocked(api.syncModels)
      .mockReturnValueOnce(cancelled.promise)
      .mockReturnValueOnce(switched.promise)
      .mockReturnValueOnce(unmounted.promise);
    const control = (workspaceId: string) => <SyncModels key={workspaceId} workspaceId={workspaceId} providers={['openai']} />;
    const page = renderSettings(control('ws-1'), 'en');
    const clickSync = () => user.click(screen.getByRole('button', { name: 'Sync all models' }));
    await clickSync();
    await user.click(screen.getByRole('button', { name: 'Cancel sync' }));
    expect(screen.getByText('Cancelled')).toBeDefined();
    await clickSync();
    page.rerender(control('ws-2'));
    await clickSync();
    await act(async () => {
      cancelled.resolve(liveResponse());
      switched.resolve(liveResponse());
    });
    expect(screen.getByText('Syncing catalog…')).toBeDefined();
    expect(screen.queryByText(/Last live sync/)).toBeNull();
    page.rerender(<></>);
    await act(async () => unmounted.resolve(liveResponse()));
    expect(vi.mocked(api.syncModels).mock.calls.map(([, , signal]) => signal.aborted)).toEqual([true, true, true]);
    for (const workspaceId of ['ws-1', 'ws-2']) {
      page.rerender(<ModelSelect key={workspaceId} workspaceId={workspaceId} provider="openai" id="picker" label="Model picker" value="claude-3-7-sonnet" onChange={vi.fn()} />);
      await screen.findByText('Claude 3.7 Sonnet');
      await user.click(screen.getByRole('button', { name: 'Model picker' }));
      expect(screen.getByRole('option', { name: 'Claude 3.7 Sonnet' })).toBeDefined();
      expect(screen.queryByRole('option', { name: 'New model' })).toBeNull();
    }
  });

  it('keeps the new picker options when an older sync finishes after credentials change', async () => {
    const user = userEvent.setup();
    const pendingKeys = new Promise<{ keys: [] }>(() => {});
    const previousSync = pendingCatalog();
    vi.mocked(api.syncModels).mockReturnValueOnce(previousSync.promise);
    function CredentialChange() {
      const client = useQueryClient();
      useQuery({ queryKey: ['workspaces', 'ws-1', 'keys'], queryFn: () => pendingKeys, initialData: { keys: [] } });
      return <button type="button" onClick={() => void refreshCredentialQueries(client, 'ws-1')}>Change credentials</button>;
    }
    renderSettings(<>
      <CredentialChange />
      <SyncModels workspaceId="ws-1" providers={['openai']} />
      <ModelSelect workspaceId="ws-1" provider="openai" id="picker" label="Model picker" value="" onChange={vi.fn()} />
    </>, 'en');
    const picker = screen.getByRole('button', { name: 'Model picker' }) as HTMLButtonElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Change credentials' }));
    await user.click(screen.getByRole('button', { name: 'Sync all models' }));
    vi.mocked(api.getModels).mockResolvedValueOnce({ models: [{ id: 'current-account', name: 'Current account model', efforts: [] }] });
    await user.click(screen.getByRole('button', { name: 'Change credentials' }));
    await act(async () => previousSync.resolve(liveResponse()));
    expect(screen.getByText(/Credentials changed/)).toBeDefined();
    expect(screen.queryByText(/Last live sync/)).toBeNull();
    await user.click(picker);
    expect(await screen.findByRole('option', { name: 'Current account model' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'New model' })).toBeNull();
  });

  it('makes no request with no connected review providers', () => {
    renderSettings(<SyncModels workspaceId="ws-1" providers={[]} />, 'en');
    expect((screen.getByRole('button', { name: 'Sync all models' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Connect a review provider/)).toBeDefined();
    expect(api.syncModels).not.toHaveBeenCalled();
  });
});

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      syncModels: vi.fn(),
      getModels: vi.fn().mockResolvedValue({
        models: [
          { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', efforts: ['low', 'medium', 'high'] },
        ],
      }),
      testConnection: vi.fn().mockResolvedValue({
        ok: true,
        ms: 120,
        model: 'claude-3-7-sonnet',
      }),
    },
  };
});

describe('SettingsPage - validation, permissions, and key privacy', () => {
  const mockUpdateSettings = vi.fn();
  const mockSaveKey = vi.fn();
  const mockDeleteKey = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setupMocks = ({
    role = 'admin' as 'owner' | 'admin' | 'member',
    settings = {
      provider: 'anthropic' as const,
      model: 'claude-3-7-sonnet',
      language: 'ar' as const,
      monthlyBudgetUsd: 100,
    },
    keys = [
      {
        provider: 'anthropic' as const,
        last4: '9999',
        createdAt: '2026-10-01',
        createdBy: 'user-1',
      },
    ] as KeyItem[],
  }: {
    role?: 'owner' | 'admin' | 'member';
    settings?: { provider: 'anthropic'; model: string; language: 'ar'; monthlyBudgetUsd: number };
    keys?: KeyItem[];
  } = {}) => {
    vi.mocked(hooks.useMeQuery).mockReturnValue({
      data: {
        user: { id: 'u1', email: 'admin@test.com', name: 'Admin', image: null, githubLinked: true },
        workspaces: [{ id: 'ws-1', name: 'Workspace 1', slug: 'ws-1', role }],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useMeQuery>);

    vi.mocked(hooks.useSettingsQuery).mockReturnValue({
      data: { settings },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useSettingsQuery>);

    vi.mocked(hooks.useUpdateSettingsMutation).mockReturnValue({
      mutateAsync: mockUpdateSettings,
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useUpdateSettingsMutation>);

    vi.mocked(hooks.useKeysQuery).mockReturnValue({
      data: { keys },
      isLoading: false,
    } as unknown as ReturnType<typeof hooks.useKeysQuery>);

    vi.mocked(hooks.useSaveKeyMutation).mockReturnValue({
      mutateAsync: mockSaveKey,
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useSaveKeyMutation>);

    vi.mocked(hooks.useDeleteKeyMutation).mockReturnValue({
      mutateAsync: mockDeleteKey,
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useDeleteKeyMutation>);

    vi.mocked(hooks.useSetProviderDefaultMethodMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useSetProviderDefaultMethodMutation>);

    vi.mocked(hooks.useDisconnectSubscriptionMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useDisconnectSubscriptionMutation>);

    vi.mocked(hooks.useRenameWorkspaceMutation).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useRenameWorkspaceMutation>);

    vi.mocked(hooks.useDeleteWorkspaceMutation).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useDeleteWorkspaceMutation>);

    vi.mocked(hooks.useRunReposQuery).mockReturnValue({
      data: { repos: [] },
    } as unknown as ReturnType<typeof hooks.useRunReposQuery>);
  };

  const renderComponent = () =>
    render(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        React.createElement(
        I18nProvider,
        { initialLanguage: 'ar' },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/w/ws-1/settings'] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, {
                path: '/w/:workspaceId/settings',
                element: React.createElement(SettingsPage, null),
              }),
            ),
          ),
        ),
      ),
      ),
    );

  it('validates settings form: model required and budget must be positive', async () => {
    const user = userEvent.setup();
    setupMocks({ role: 'admin' });
    renderComponent();

    // Switch to manual model entry to test manual clear and validation
    const manualBtn = screen.getByRole('button', { name: /إدخال يدوي/i });
    await user.click(manualBtn);

    const modelInput = screen.getByLabelText(/اسم النموذج/i);
    const budgetInput = screen.getByLabelText(/الميزانية الشهرية/i);
    const saveButton = screen.getByRole('button', { name: /حفظ الإعدادات/i });

    // Clear model input
    await user.clear(modelInput);
    await user.click(saveButton);

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/اسم النموذج مطلوب/i)).toBeDefined();

    // Type valid model and invalid negative budget
    await user.type(modelInput, 'claude-3-7-sonnet');
    await user.clear(budgetInput);
    await user.type(budgetInput, '-10');
    await user.click(saveButton);

    expect(mockUpdateSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/الميزانية يجب أن تكون رقمًا موجبًا/i)).toBeDefined();
  });

  it('enforces member read-only mode', () => {
    setupMocks({ role: 'member' });
    renderComponent();
    expect(screen.queryByRole('button', { name: 'مزامنة كل النماذج' })).toBeNull();

    // Member banner should be visible
    expect(screen.getByText(/أنت تتصفح الإعدادات كعضو فقط/i)).toBeDefined();

    // Form inputs should be disabled
    const modelInput = screen.getByLabelText(/اسم النموذج/i) as HTMLInputElement;
    expect(modelInput.disabled).toBe(true);

    // Save button should be disabled or absent
    const saveButton = screen.queryByRole('button', { name: /حفظ الإعدادات/i });
    expect(saveButton === null || (saveButton as HTMLButtonElement).disabled).toBe(true);

    // Add key button should not be present
    expect(screen.queryByRole('button', { name: /إضافة بيانات دخول/i })).toBeNull();
  });

  it('offers model sync to an admin with connected review credentials', () => {
    setupMocks();
    renderComponent();
    expect((screen.getByRole('button', { name: 'مزامنة كل النماذج' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the rename card to admin/owner and the danger zone to the owner only', () => {
    setupMocks({ role: 'admin' });
    const { unmount } = renderComponent();
    expect((screen.getByLabelText(/اسم مساحة العمل/i) as HTMLInputElement).value).toBe('Workspace 1');
    expect(screen.getByRole('button', { name: /تغيير الاسم/i })).toBeDefined();
    expect(screen.queryByText(/منطقة الخطر/i)).toBeNull();
    unmount();

    setupMocks({ role: 'owner' });
    renderComponent();
    expect(screen.getByText(/منطقة الخطر/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /حذف مساحة العمل/i })).toBeDefined();
  });

  it('shows the default-method selector only when subscription and API keys coexist', () => {
    setupMocks({
      role: 'admin',
      keys: [
        {
          provider: 'openai' as const,
          last4: '1111',
          createdAt: '2026-10-01',
          createdBy: 'user-1',
          hasSubscription: true,
          defaultMethod: 'subscription' as const,
          keys: [{ id: 'k1', position: 0, last4: '4242', createdAt: '2026-10-01', lastTestStatus: null, lastTestedAt: null }],
        },
        {
          provider: 'anthropic' as const,
          last4: '9999',
          createdAt: '2026-10-01',
          createdBy: 'user-1',
          hasSubscription: true,
          keys: [],
        },
      ],
    });
    renderComponent();
    expect(screen.getAllByLabelText(/الطريقة الافتراضية/i)).toHaveLength(1);
  });

  it('asks for a new sign-in when the provider refused the subscription refresh', () => {
    setupMocks({
      role: 'admin',
      keys: [
        {
          provider: 'anthropic' as const,
          last4: '9999',
          createdAt: '2026-10-01',
          createdBy: 'user-1',
          hasSubscription: true,
          defaultMethod: 'subscription' as const,
          signInRequiredAt: '2026-10-19T17:26:00.000Z',
        },
      ],
    });
    renderComponent();
    expect(screen.getByText(/تسجيل الدخول للاشتراك انتهى/)).toBeDefined();
    expect(screen.getByRole('button', { name: /سجّل دخول تاني/ })).toBeDefined();
  });

  it('shows no sign-in alert while the subscription refresh is healthy', () => {
    setupMocks({
      role: 'admin',
      keys: [
        {
          provider: 'anthropic' as const,
          last4: '9999',
          createdAt: '2026-10-01',
          createdBy: 'user-1',
          hasSubscription: true,
          defaultMethod: 'subscription' as const,
        },
      ],
    });
    renderComponent();
    expect(screen.queryByText(/تسجيل الدخول للاشتراك انتهى/)).toBeNull();
    expect(screen.queryByRole('button', { name: /سجّل دخول تاني/ })).toBeNull();
  });

  it('add-key never shows the key after save', async () => {
    const user = userEvent.setup();
    const fakeSecret = 'sk-test-secret-99999999';
    setupMocks({ role: 'admin' });
    mockSaveKey.mockResolvedValueOnce(undefined);

    renderComponent();

    const addKeyBtn = screen.getByRole('button', { name: /إضافة بيانات دخول/i });
    await user.click(addKeyBtn);

    // Modal opens with password input
    const secretInput = screen.getByLabelText(/المفتاح السري/i) as HTMLInputElement;
    expect(secretInput.type).toBe('password');

    await user.type(secretInput, fakeSecret);

    const submitKeyBtn = screen.getByRole('button', { name: /حفظ المفتاح/i });
    await user.click(submitKeyBtn);

    expect(mockSaveKey).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: fakeSecret,
      apiKeys: [fakeSecret],
    });

    // Wait for modal to close
    await waitFor(() => {
      expect(screen.queryByLabelText(/المفتاح السري/i)).toBeNull();
    });

    // Secret must NEVER be present anywhere in the document
    expect(document.body.textContent).not.toContain(fakeSecret);
  });
});
