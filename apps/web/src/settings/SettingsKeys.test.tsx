import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, ApiClientError } from '../api/client.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
import { TestKeyButton } from './TestKeyButton.js';
import { renderSettings, typedKey } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, api: { ...actual.api, getModels: vi.fn(), testConnection: vi.fn(), testModelsUnsaved: vi.fn() } };
});

describe('key test icon and "test before saving" (J2)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TestKeyButton: spinner, then a success badge with latency', async () => {
    let resolve: (v: { ok: boolean; ms: number; model: string }) => void = () => undefined;
    vi.mocked(api.testConnection).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderSettings(<TestKeyButton workspaceId="ws-1" provider="openrouter" />, 'en');
    const button = screen.getByRole('button', { name: /Test connection/ });
    await user.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    resolve({ ok: true, ms: 154, model: 'm' });
    expect(await screen.findByText('154ms')).toBeDefined();
    expect(screen.getByTitle(/Connected successfully/)).toBeDefined();
    expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'openrouter');
  });

  it('TestKeyButton: a failure shows the translated reason, with the server message on hover', async () => {
    vi.mocked(api.testConnection).mockResolvedValueOnce({ ok: false, code: 'quota', message: 'credit exhausted' });
    renderSettings(<TestKeyButton workspaceId="ws-1" provider="zai-coding" />, 'en');
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    expect(await screen.findByText('Quota or credit exhausted')).toBeDefined();
    expect(screen.getByTitle('Quota or credit exhausted: credit exhausted')).toBeDefined();
  });

  it('TestKeyButton: a refused request (rate limit) is shown as a failure, not thrown', async () => {
    vi.mocked(api.testConnection).mockRejectedValueOnce(new ApiClientError('too many', 'rate_limited', 429));
    renderSettings(<TestKeyButton workspaceId="ws-1" provider="openai" />, 'ar');
    await user.click(screen.getByRole('button', { name: /اختبار الاتصال/ }));
    expect(await screen.findByText(/تم تجاوز معدل الطلبات/)).toBeDefined();
  });

  it('TestKeyButton: model picker defaults to Auto, loads models on open, sends chosen model and tooltip names the model tested', async () => {
    vi.mocked(api.getModels).mockResolvedValueOnce({
      models: [
        { id: 'mimo-v2-flash', name: 'MiMo v2 Flash', efforts: [] },
        { id: 'mimo-v2-pro', name: 'MiMo v2 Pro', efforts: [] },
      ],
    });
    vi.mocked(api.testConnection).mockResolvedValueOnce({ ok: true, ms: 88, model: 'mimo-v2-pro' });
    renderSettings(<TestKeyButton workspaceId="ws-1" provider="xiaomi" />, 'en');

    const picker = screen.getByRole('combobox', { name: /model/i });
    expect(api.getModels).not.toHaveBeenCalled();
    picker.focus();
    await screen.findByRole('option', { name: 'MiMo v2 Pro' });
    await user.selectOptions(picker, 'mimo-v2-pro');

    const button = screen.getByRole('button', { name: /Test connection/ });
    await user.click(button);

    expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'xiaomi', { model: 'mimo-v2-pro' });
    expect(await screen.findByText('88ms')).toBeDefined();
    expect(screen.getByTitle(/mimo-v2-pro/)).toBeDefined();
  });

  it('AddKeyModal tests a preset key before saving, sending no base URL', async () => {
    vi.mocked(api.testConnection).mockResolvedValueOnce({ ok: true, ms: 40, model: 'glm-5' });
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws-1" />, 'en');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'zai-coding');
    await user.type(screen.getByLabelText('Secret API Key'), typedKey());
    await user.click(screen.getByRole('button', { name: 'Test before saving' }));
    await waitFor(() =>
      expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'zai-coding', { apiKey: typedKey(), baseUrl: undefined, model: undefined }),
    );
    expect(await screen.findByText(/Connected successfully/)).toBeDefined();
  });

  it('AddKeyModal offers both MiniMax providers with their English labels', async () => {
    const { container } = renderSettings(
      <AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws-1" />,
      'en',
    );
    const select = container.querySelector('#key-provider-select') as HTMLSelectElement;
    const labels = Array.from(select.options).map((option) => option.textContent);

    expect(labels).toContain('MiniMax');
    expect(labels).toContain('MiniMax Coding Plan');
  });

  it('AddKeyModal offers both MiniMax providers with their Arabic labels', async () => {
    const { container } = renderSettings(
      <AddKeyModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} isPending={false} workspaceId="ws-1" />,
      'ar',
    );
    const select = container.querySelector('#key-provider-select') as HTMLSelectElement;
    const labels = Array.from(select.options).map((option) => option.textContent);

    expect(labels).toContain('ميني ماكس');
    expect(labels).toContain('ميني ماكس Coding Plan');
  });

  it('AddKeyModal tests a custom key with its base URL against the first listed model', async () => {
    vi.mocked(api.testModelsUnsaved).mockResolvedValueOnce({ models: [{ id: 'llama-3.3', name: 'Llama', efforts: [] }] });
    vi.mocked(api.testConnection).mockResolvedValueOnce({ ok: false, code: 'auth', message: 'denied' });
    const onSubmit = vi.fn(async () => undefined);
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={onSubmit} isPending={false} workspaceId="ws-1" />, 'en');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'custom');
    await user.type(screen.getByLabelText(/Base URL/), 'https://llm.example.com/v1');
    await user.type(screen.getByLabelText('Secret API Key'), typedKey());
    await user.click(screen.getByRole('button', { name: 'Test before saving' }));
    expect(await screen.findByText(/Invalid or unauthorized key/)).toBeDefined();
    expect(api.testModelsUnsaved).toHaveBeenCalledWith('ws-1', 'custom', typedKey(), 'https://llm.example.com/v1');
    expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'custom', {
      apiKey: typedKey(),
      baseUrl: 'https://llm.example.com/v1',
      model: 'llama-3.3',
    });
    expect(screen.queryByText(typedKey())).toBeNull();

    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSubmit).toHaveBeenCalledWith('custom', typedKey(), 'https://llm.example.com/v1');
  });
});
