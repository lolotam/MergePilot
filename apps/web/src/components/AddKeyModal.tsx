import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api, type ApiProvider, type TestConnectionResponse } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { ProviderSelect } from '../settings/providers.js';
import { runConnectionTest, useTestReason } from '../settings/TestKeyButton.js';
import { Modal } from './Modal.js';

export interface AddKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (provider: ApiProvider, apiKey: string, baseUrl?: string | undefined) => Promise<void>;
  isPending: boolean;
  workspaceId?: string | undefined;
}

export function AddKeyModal({ isOpen, onClose, onSubmit, isPending, workspaceId }: AddKeyModalProps) {
  const { t } = useI18n();
  const testReason = useTestReason();
  const [keyProvider, setKeyProvider] = useState<ApiProvider>('anthropic');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [keyError, setKeyError] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);

  const handleClose = () => {
    setApiKeyInput('');
    setBaseUrlInput('');
    setKeyError('');
    setTestResult(null);
    onClose();
  };

  const handleTestBeforeSave = async () => {
    if (!workspaceId || apiKeyInput.length < 8) {
      setKeyError(t('keySecretMinLength'));
      return;
    }
    if (keyProvider === 'custom' && !baseUrlInput.trim().startsWith('https://')) {
      setKeyError(t('baseUrlHelp'));
      return;
    }

    setIsTesting(true);
    setTestResult(null);
    setKeyError('');
    const apiKey = apiKeyInput.trim();
    const baseUrl = keyProvider === 'custom' ? baseUrlInput.trim() : undefined;
    // The typed key goes only to this one test call: it is never stored, logged or shown.
    const result = await runConnectionTest(async () => {
      let model: string | undefined;
      if (keyProvider === 'custom') {
        // A custom server has no default model: test the first one it lists.
        const { models } = await api.testModelsUnsaved(workspaceId, keyProvider, apiKey, baseUrl);
        model = models[0]?.id;
        if (!model) return { ok: false, code: 'invalid-response', message: '' };
      }
      return api.testConnection(workspaceId, keyProvider, { apiKey, baseUrl, model });
    });
    setTestResult(result);
    setIsTesting(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError('');

    if (apiKeyInput.length < 8) {
      setKeyError(t('keySecretMinLength'));
      return;
    }

    if (keyProvider === 'custom') {
      const trimmedUrl = baseUrlInput.trim();
      if (!trimmedUrl.startsWith('https://')) {
        setKeyError(t('baseUrlHelp'));
        return;
      }
    }

    const secretToSave = apiKeyInput.trim();
    const urlToSave = keyProvider === 'custom' ? baseUrlInput.trim() || undefined : undefined;
    setApiKeyInput('');
    setBaseUrlInput('');
    setTestResult(null);
    await onSubmit(keyProvider, secretToSave, urlToSave);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t('addKeyModalTitle')}
      description={t('addKeyModalDesc')}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
        <ProviderSelect
          id="key-provider-select"
          label={t('keyProviderCol')}
          value={keyProvider}
          onChange={(next) => {
            setKeyProvider(next);
            setTestResult(null);
            setKeyError('');
          }}
        />

        {keyProvider === 'custom' && (
          <div>
            <label htmlFor="key-base-url-input" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
              {t('baseUrlLabel')}
            </label>
            <input
              id="key-base-url-input"
              type="url"
              required
              value={baseUrlInput}
              onChange={(e) => {
                setBaseUrlInput(e.target.value);
                setTestResult(null);
                if (keyError) setKeyError('');
              }}
              placeholder={t('baseUrlPlaceholder')}
              className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs font-mono text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            />
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('baseUrlHelp')}</p>
          </div>
        )}

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
              setTestResult(null);
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

        {/* Test Result Banner */}
        {testResult && (
          <div
            role="status"
            className={`p-2.5 rounded-xl text-xs flex items-center gap-2 ${
              testResult.ok
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                : 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            ) : (
              <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            )}
            <span title={testResult.ok ? undefined : testResult.message}>
              {testResult.ok
                ? t('testKeySuccess', { ms: String(testResult.ms ?? 0) })
                : t('testKeyFailed', { reason: testReason(testResult.code) })}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2.5 mt-3">
          {workspaceId ? (
            <button
              type="button"
              disabled={isTesting || isPending || apiKeyInput.length < 8}
              onClick={handleTestBeforeSave}
              className="px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              {isTesting && (
                <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
              )}
              {isTesting ? t('testingKey') : t('testBeforeSave')}
            </button>
          ) : <div />}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={isPending || isTesting || !apiKeyInput.trim()}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {isPending ? t('savingKey') : t('saveKeyButton')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
