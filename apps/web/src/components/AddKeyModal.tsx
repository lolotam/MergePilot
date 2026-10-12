import { useState } from 'react';
import type { ApiProvider } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { Modal } from './Modal.js';

export interface AddKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (provider: ApiProvider, apiKey: string) => Promise<void>;
  isPending: boolean;
}

export function AddKeyModal({ isOpen, onClose, onSubmit, isPending }: AddKeyModalProps) {
  const { t } = useI18n();
  const [keyProvider, setKeyProvider] = useState<ApiProvider>('anthropic');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');

  const handleClose = () => {
    setApiKeyInput('');
    setKeyError('');
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError('');

    if (apiKeyInput.length < 8) {
      setKeyError(t('keySecretMinLength'));
      return;
    }

    const secretToSave = apiKeyInput;
    setApiKeyInput('');
    await onSubmit(keyProvider, secretToSave);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('addKeyModalTitle')}
      description={t('addKeyModalDesc')}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
        <div>
          <label htmlFor="key-provider-select" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
            {t('keyProviderCol')}
          </label>
          <select
            id="key-provider-select"
            value={keyProvider}
            onChange={(e) => setKeyProvider(e.target.value as ApiProvider)}
            className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          >
            <option value="anthropic">{t('providerAnthropic') || 'Anthropic'}</option>
            <option value="openai">{t('providerOpenai') || 'OpenAI'}</option>
            <option value="gemini">{t('providerGemini') || 'Google Gemini'}</option>
          </select>
        </div>

        <div>
          <label htmlFor="key-secret-input" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
            {t('keySecretLabel')}
          </label>
          <input
            id="key-secret-input"
            type="password"
            required
            autoComplete="off"
            value={apiKeyInput}
            onChange={(e) => {
              setApiKeyInput(e.target.value);
              if (keyError) setKeyError('');
            }}
            placeholder={t('keySecretPlaceholder')}
            className={`w-full px-3.5 py-2 rounded-full border text-xs font-mono focus:ring-2 focus:outline-hidden ${
              keyError
                ? 'border-red-500 focus:ring-red-500'
                : 'border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:ring-brand-500'
            }`}
          />
          {keyError ? (
            <p className="text-xs text-red-500 mt-1 ms-2">{keyError}</p>
          ) : (
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('keySecretHelp')}</p>
          )}
        </div>

        <div className="flex justify-end gap-2.5 mt-3">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={isPending || !apiKeyInput.trim()}
            className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          >
            {isPending ? t('savingKey') : t('saveKeyButton')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
