import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api/client.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
import { renderSettings, typedKey } from './settings.fixtures.js';

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return { ...actual, api: { ...actual.api, getModels: vi.fn(), testConnection: vi.fn(), testModelsUnsaved: vi.fn() } };
});

const COPY = {
  en: {
    provider: 'Provider',
    secret: 'Secret API Key',
    add: 'Add another API key',
    remove2: 'Remove this API key 2',
    test1: 'Test connection 1',
    valid: 'Valid, quota remaining',
    invalid: 'Invalid key',
    quota: 'Quota exhausted',
    save: 'Save key',
  },
  ar: {
    provider: 'المزود',
    secret: 'المفتاح السري (API Key)',
    add: 'إضافة مفتاح API آخر',
    remove2: 'إزالة هذا المفتاح 2',
    test1: 'اختبار الاتصال 1',
    valid: 'المفتاح صالح وفيه حصة متبقية',
    invalid: 'المفتاح غير صالح',
    quota: 'نفدت حصة هذا المفتاح',
    save: 'حفظ المفتاح',
  },
} as const;

describe('AddKeyModal multi-key fields', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['en', 'ar'] as const)('adds and removes a field, tests the three outcomes, and stops at 20 (%s)', async (language) => {
    const copy = COPY[language];
    const key = typedKey();
    const onSubmit = vi.fn(async () => undefined);
    vi.mocked(api.testConnection)
      .mockResolvedValueOnce({ ok: true, ms: 12, model: 'gemini-2.0-flash', quotaStatus: 'valid' })
      .mockResolvedValueOnce({ ok: false, code: 'auth', message: 'no', quotaStatus: 'invalid' })
      .mockResolvedValueOnce({ ok: false, code: 'quota', message: 'over', quotaStatus: 'quota-exhausted' });
    renderSettings(<AddKeyModal isOpen onClose={vi.fn()} onSubmit={onSubmit} isPending={false} workspaceId="ws-1" />, language);

    expect(screen.queryByRole('button', { name: copy.add })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: copy.provider }), 'gemini');
    const add = screen.getByRole('button', { name: copy.add });
    await user.click(add);
    expect(screen.getAllByPlaceholderText('sk-...')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: copy.remove2 }));
    expect(screen.getAllByPlaceholderText('sk-...')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Test before saving|اختبر قبل الحفظ/ })).toBeNull();

    await user.type(screen.getByLabelText(copy.secret), key);
    const test = screen.getByRole('button', { name: copy.test1 });
    await user.click(test);
    expect(await screen.findByText(copy.valid)).toBeDefined();
    await user.click(test);
    expect(await screen.findByText(copy.invalid)).toBeDefined();
    await user.click(test);
    expect(await screen.findByText(copy.quota)).toBeDefined();
    expect(screen.queryByText(key)).toBeNull();
    expect(api.testConnection).toHaveBeenCalledWith('ws-1', 'gemini', { apiKey: key });

    await user.click(screen.getByRole('button', { name: copy.save }));
    expect(onSubmit).toHaveBeenCalledWith('gemini', key, undefined, [key]);

    for (let extra = 0; extra < 19; extra += 1) await user.click(screen.getByRole('button', { name: copy.add }));
    expect(screen.getAllByPlaceholderText('sk-...')).toHaveLength(20);
    expect((screen.getByRole('button', { name: copy.add }) as HTMLButtonElement).disabled).toBe(true);
  });
});
