import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { I18nProvider } from '../i18n/context.js';
import { api, type ApiProvider } from '../api/client.js';
import { ModelSelect } from './ModelSelect.js';
import { EffortSelect } from './EffortSelect.js';
import { SeveritySelect } from './SeveritySelect.js';
import { HeavyModelCard } from './HeavyModelCard.js';
import { FallbackModelsCard } from './FallbackModelsCard.js';
import { TestKeyButton } from './TestKeyButton.js';
import { AddKeyModal } from '../components/AddKeyModal.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getModels: vi.fn(),
      testConnection: vi.fn(),
      saveKey: vi.fn(),
    },
  };
});

describe('Task J2 Settings Components', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithI18n = (ui: React.ReactElement) =>
    render(React.createElement(I18nProvider, { initialLanguage: 'ar' }, ui));

  describe('ModelSelect & EffortSelect', () => {
    it('populates models dropdown and triggers onChange with efforts', async () => {
      const mockOnChange = vi.fn();
      vi.mocked(api.getModels).mockResolvedValueOnce({
        models: [
          { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', efforts: ['low', 'medium', 'high'] },
          { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', efforts: [] },
        ],
      });

      renderWithI18n(
        React.createElement(ModelSelect, {
          workspaceId: 'ws-1',
          provider: 'anthropic' as ApiProvider,
          value: '',
          onChange: mockOnChange,
        }),
      );

      // Open dropdown
      const trigger = await screen.findByRole('button', { name: /اسم النموذج/i });
      await user.click(trigger);

      // Select Claude 3.7 Sonnet
      const option = await screen.findByText('Claude 3.7 Sonnet');
      await user.click(option);

      expect(mockOnChange).toHaveBeenCalledWith('claude-3-7-sonnet', ['low', 'medium', 'high']);
    });

    it('renders effort options and updates value', async () => {
      const mockOnChange = vi.fn();
      renderWithI18n(
        React.createElement(EffortSelect, {
          efforts: ['low', 'medium', 'high'],
          value: 'medium',
          onChange: mockOnChange,
        }),
      );

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('medium');

      await user.selectOptions(select, 'high');
      expect(mockOnChange).toHaveBeenCalledWith('high');
    });

    it('returns null when model has no effort options', () => {
      const { container } = renderWithI18n(
        React.createElement(EffortSelect, {
          efforts: [],
          value: null,
          onChange: vi.fn(),
        }),
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('HeavyModelCard', () => {
    it('enables heavy duty model and updates threshold and provider', async () => {
      const mockOnChange = vi.fn();
      renderWithI18n(
        React.createElement(HeavyModelCard, {
          workspaceId: 'ws-1',
          heavyProvider: null,
          heavyModel: null,
          heavyEffort: null,
          heavyThresholdLines: null,
          onChange: mockOnChange,
        }),
      );

      // Toggle enable
      const toggle = screen.getByRole('checkbox');
      expect((toggle as HTMLInputElement).checked).toBe(false);

      await user.click(toggle);
      expect(mockOnChange).toHaveBeenCalledWith({
        heavyProvider: 'anthropic',
        heavyModel: 'claude-3-7-sonnet',
        heavyEffort: null,
        heavyThresholdLines: 800,
      });
    });
  });

  describe('FallbackModelsCard', () => {
    it('allows adding, reordering and removing fallback models (max 3)', async () => {
      const initial = [
        { provider: 'openai' as ApiProvider, model: 'gpt-4o', effort: null },
        { provider: 'gemini' as ApiProvider, model: 'gemini-2.5-pro', effort: null },
      ];
      let current = initial;
      const mockOnChange = vi.fn((next) => {
        current = next;
      });

      const { rerender } = renderWithI18n(
        React.createElement(FallbackModelsCard, {
          workspaceId: 'ws-1',
          fallbacks: current,
          onChange: mockOnChange,
        }),
      );

      // Add third fallback
      const addBtn = screen.getByRole('button', { name: /إضافة نموذج احتياطي/i });
      await user.click(addBtn);

      expect(mockOnChange).toHaveBeenCalledWith([
        ...initial,
        { provider: 'openai', model: 'gpt-4o', effort: null },
      ]);

      rerender(
        React.createElement(
          I18nProvider,
          { initialLanguage: 'ar' },
          React.createElement(FallbackModelsCard, {
            workspaceId: 'ws-1',
            fallbacks: current,
            onChange: mockOnChange,
          }),
        ),
      );

      // Move up the second item (index 1)
      const moveUpBtns = screen.getAllByTitle(/تحريك للأعلى/i);
      expect(moveUpBtns[1]).toBeDefined();
      await user.click(moveUpBtns[1]!);

      expect(mockOnChange).toHaveBeenLastCalledWith([
        { provider: 'gemini', model: 'gemini-2.5-pro', effort: null },
        { provider: 'openai', model: 'gpt-4o', effort: null },
        { provider: 'openai', model: 'gpt-4o', effort: null },
      ]);

      rerender(
        React.createElement(
          I18nProvider,
          { initialLanguage: 'ar' },
          React.createElement(FallbackModelsCard, {
            workspaceId: 'ws-1',
            fallbacks: current,
            onChange: mockOnChange,
          }),
        ),
      );

      // Remove the last item
      const removeBtns = screen.getAllByRole('button', { name: /إزالة/i });
      expect(removeBtns[2]).toBeDefined();
      await user.click(removeBtns[2]!);

      expect(mockOnChange).toHaveBeenLastCalledWith([
        { provider: 'gemini', model: 'gemini-2.5-pro', effort: null },
        { provider: 'openai', model: 'gpt-4o', effort: null },
      ]);
    });
  });

  describe('TestKeyButton', () => {
    it('handles successful test connection with latency', async () => {
      vi.mocked(api.testConnection).mockResolvedValueOnce({
        ok: true,
        ms: 154,
        model: 'claude-3-7-sonnet',
      });

      renderWithI18n(
        React.createElement(TestKeyButton, {
          workspaceId: 'ws-1',
          provider: 'anthropic' as ApiProvider,
        }),
      );

      const testBtn = screen.getByRole('button', { name: /اختبار الاتصال/i });
      await user.click(testBtn);

      await waitFor(() => {
        expect(screen.getByText('154ms')).toBeDefined();
        expect(screen.getByText('✅')).toBeDefined();
      });
    });

    it('handles failed test connection with error code', async () => {
      vi.mocked(api.testConnection).mockResolvedValueOnce({
        ok: false,
        code: 'auth_failed',
        message: 'Invalid API key',
      });

      renderWithI18n(
        React.createElement(TestKeyButton, {
          workspaceId: 'ws-1',
          provider: 'anthropic' as ApiProvider,
        }),
      );

      const testBtn = screen.getByRole('button', { name: /اختبار الاتصال/i });
      await user.click(testBtn);

      await waitFor(() => {
        expect(screen.getByText('auth_failed')).toBeDefined();
        expect(screen.getByText('❌')).toBeDefined();
      });
    });
  });

  describe('SeveritySelect', () => {
    it('changes minimum severity level', async () => {
      const mockOnChange = vi.fn();
      renderWithI18n(
        React.createElement(SeveritySelect, {
          value: 'medium',
          onChange: mockOnChange,
        }),
      );

      const select = screen.getByRole('combobox') as HTMLSelectElement;
      expect(select.value).toBe('medium');

      await user.selectOptions(select, 'high');
      expect(mockOnChange).toHaveBeenCalledWith('high');
    });
  });

  describe('AddKeyModal - test before saving and baseUrl', () => {
    it('tests unsaved key before saving and supports baseUrl for custom provider', async () => {
      vi.mocked(api.testConnection).mockResolvedValueOnce({
        ok: true,
        ms: 88,
        model: 'custom-model',
      });

      renderWithI18n(
        React.createElement(AddKeyModal, {
          isOpen: true,
          onClose: vi.fn(),
          onSubmit: vi.fn(),
          isPending: false,
          workspaceId: 'ws-1',
        }),
      );

      // Select custom provider
      const providerSelect = screen.getByLabelText(/المزود/i);
      await user.selectOptions(providerSelect, 'custom');

      // Base URL field should now be visible
      const baseUrlInput = screen.getByLabelText(/الرابط الأساسي/i);
      await user.type(baseUrlInput, 'https://custom-llm.example.com/v1');

      // Enter key
      const keyInput = screen.getByLabelText(/المفتاح السري/i);
      await user.type(keyInput, 'sk-custom-test-12345');

      // Test before saving
      const testBtn = screen.getByRole('button', { name: /اختبر قبل الحفظ/i });
      await user.click(testBtn);

      await waitFor(() => {
        expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'custom', {
          apiKey: 'sk-custom-test-12345',
          baseUrl: 'https://custom-llm.example.com/v1',
        });
        expect(screen.getByText(/الاتصال ناجح/i)).toBeDefined();
      });
    });
  });
});
