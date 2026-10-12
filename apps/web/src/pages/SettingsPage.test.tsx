import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from './SettingsPage.js';
import { I18nProvider } from '../i18n/context.js';
import { ToastProvider } from '../components/Toast.js';
import * as hooks from '../api/hooks.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
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
    ],
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

    vi.mocked(hooks.useRenameWorkspaceMutation).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useRenameWorkspaceMutation>);

    vi.mocked(hooks.useDeleteWorkspaceMutation).mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof hooks.useDeleteWorkspaceMutation>);
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

    // Member banner should be visible
    expect(screen.getByText(/أنت تتصفح الإعدادات كعضو فقط/i)).toBeDefined();

    // Form inputs should be disabled
    const modelInput = screen.getByLabelText(/اسم النموذج/i) as HTMLInputElement;
    expect(modelInput.disabled).toBe(true);

    // Save button should be disabled or absent
    const saveButton = screen.queryByRole('button', { name: /حفظ الإعدادات/i });
    expect(saveButton === null || (saveButton as HTMLButtonElement).disabled).toBe(true);

    // Add key button should not be present
    expect(screen.queryByRole('button', { name: /إضافة مفتاح جديد/i })).toBeNull();
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

  it('add-key never shows the key after save', async () => {
    const user = userEvent.setup();
    const fakeSecret = 'sk-test-secret-99999999';
    setupMocks({ role: 'admin' });
    mockSaveKey.mockResolvedValueOnce(undefined);

    renderComponent();

    const addKeyBtn = screen.getByRole('button', { name: /إضافة مفتاح جديد/i });
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
    });

    // Wait for modal to close
    await waitFor(() => {
      expect(screen.queryByLabelText(/المفتاح السري/i)).toBeNull();
    });

    // Secret must NEVER be present anywhere in the document
    expect(document.body.textContent).not.toContain(fakeSecret);
  });
});
