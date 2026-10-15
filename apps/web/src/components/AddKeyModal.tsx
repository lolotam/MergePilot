import { useEffect, useRef, useState } from 'react';
import type {
  DUAL_METHOD_PROVIDER_IDS as ServerDualIds,
  MAX_PROVIDER_KEYS as ServerMaxKeys,
  MULTI_KEY_PROVIDER_IDS as ServerMultiKeyIds,
} from '@mergepilot/app/contract';
import { Plus, X } from 'lucide-react';
import { api, type KeyProvider, type TestConnectionResponse } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { isJudgeKeyOnly, KEY_PROVIDERS, ProviderSelect } from '../settings/providers.js';
import { runConnectionTest, useTestReason } from '../settings/TestKeyButton.js';
import { Modal } from './Modal.js';
import { AddKeyModalDualSubscription } from './AddKeyModalDualSubscription.js';
import { AddKeyModalFooter } from './AddKeyModalFooter.js';
import { blankField, outcomeColor, quotaOutcome, type KeyField } from './add-key-modal-utils.js';
import { SubscriptionSignIn } from '../settings/SubscriptionSignIn.js';

/** The server's cap and provider list, checked by type so a drift fails `pnpm typecheck`. The web does not load app runtime code. */
const MAX_PROVIDER_KEYS: typeof ServerMaxKeys = 20;
const MULTI_KEY_PROVIDER_IDS: typeof ServerMultiKeyIds = ['gemini', 'openrouter', 'opencode-zen'];
const DUAL_METHOD_PROVIDER_IDS: typeof ServerDualIds = ['anthropic', 'openai', 'xai'];

function isMultiKeyProvider(provider: string): provider is (typeof MULTI_KEY_PROVIDER_IDS)[number] {
  return (MULTI_KEY_PROVIDER_IDS as readonly string[]).includes(provider);
}

function isDualMethodProvider(provider: string): provider is (typeof DUAL_METHOD_PROVIDER_IDS)[number] {
  return (DUAL_METHOD_PROVIDER_IDS as readonly string[]).includes(provider);
}

export interface AddKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** `apiKeys` is passed for providers that keep a list of API keys. A single key omits it. */
  onSubmit: (provider: KeyProvider, apiKey: string, baseUrl?: string | undefined, apiKeys?: string[] | undefined) => Promise<void>;
  isPending: boolean;
  workspaceId?: string | undefined;
}

export function AddKeyModal({ isOpen, onClose, onSubmit, isPending, workspaceId }: AddKeyModalProps) {
  const { t } = useI18n();
  const testReason = useTestReason();
  const [keyProvider, setKeyProvider] = useState<KeyProvider>('anthropic');
  const [authMethod, setAuthMethod] = useState<'api-key' | 'subscription'>('api-key');
  const dualProvider = isDualMethodProvider(keyProvider);
  const supportsSubscription = dualProvider;
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [keyError, setKeyError] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const fieldSeq = useRef(1);
  const fieldTestSeq = useRef(0);
  const [fields, setFields] = useState<KeyField[]>([blankField('field-0')]);
  const multi = isMultiKeyProvider(keyProvider) || dualProvider;

  const resetFields = () => {
    fieldSeq.current = 1;
    setFields([blankField('field-0')]);
  };

  /** Everything the user typed or chose; shared by both close paths. */
  const resetForm = () => {
    setAuthMethod('api-key');
    setApiKeyInput('');
    setBaseUrlInput('');
    setKeyError('');
    setTestResult(null);
    resetFields();
  };

  // The page closes the modal after a successful save (without handleClose); reset then, never before.
  useEffect(() => {
    if (!isOpen) resetForm();
  }, [isOpen]);

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const addField = () => {
    setFields((prev) => {
      if (prev.length >= MAX_PROVIDER_KEYS) return prev;
      const id = `field-${fieldSeq.current}`;
      fieldSeq.current += 1;
      return [...prev, blankField(id)];
    });
  };

  const removeField = (index: number) => {
    setFields((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const testField = async (fieldId: string) => {
    if (!workspaceId || !multi) return;
    const current = fields.find((field) => field.id === fieldId);
    const apiKey = current?.value.trim() ?? '';
    if (!current || apiKey.length < 8) return;
    const token = fieldTestSeq.current + 1;
    fieldTestSeq.current = token;
    setFields((prev) =>
      prev.map((item) =>
        item.id === fieldId ? { ...item, testing: true, result: null, testToken: token, testedValue: apiKey } : item,
      ),
    );
    const result = await runConnectionTest(() => api.testConnection(workspaceId, keyProvider, { apiKey }));
    setFields((prev) =>
      prev.map((item) => {
        if (item.id !== fieldId) return item;
        if (item.testToken !== token || item.testedValue !== apiKey) return { ...item, testing: false };
        return { ...item, testing: false, result };
      }),
    );
  };

  const outcomeText = (result: TestConnectionResponse): string => {
    const status = quotaOutcome(result);
    if (status === 'valid') return t('testKeyOutcomeValid');
    if (status === 'quota-exhausted') return t('testKeyOutcomeQuota');
    if (status === 'unverified') return t('testKeyOutcomeUnverified');
    return t('testKeyOutcomeInvalid');
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
      // A Jev-only key (ADR-0015) is tested with one tiny judge question instead.
      if (isJudgeKeyOnly(keyProvider)) return api.testJudge(workspaceId, { provider: keyProvider, apiKey });
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
    if (authMethod === 'subscription') return;
    setKeyError('');

    if (multi) {
      const apiKeys = fields.map((field) => field.value.trim());
      if (apiKeys.length === 0 || apiKeys.some((key) => key.length < 8)) {
        setKeyError(t('keySecretMinLength'));
        return;
      }
      const first = apiKeys[0];
      if (!first) return;
      // Fields are kept until the save succeeds and the page closes the modal (see the effect above).
      await onSubmit(keyProvider, first, undefined, apiKeys);
      return;
    }

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
      title={t(authMethod === 'subscription' ? 'subscriptionModalTitle' : 'addKeyModalTitle')}
      {...(authMethod === 'subscription' ? {} : { description: t('addKeyModalDesc') })}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
        <ProviderSelect<KeyProvider>
          id="key-provider-select"
          label={t('keyProviderCol')}
          value={keyProvider}
          options={KEY_PROVIDERS}
          onChange={(next) => {
            setKeyProvider(next);
            setAuthMethod('api-key');
            setApiKeyInput('');
            setTestResult(null);
            setKeyError('');
            resetFields();
          }}
        />

        {dualProvider && workspaceId && <AddKeyModalDualSubscription workspaceId={workspaceId} provider={keyProvider as 'anthropic' | 'openai' | 'xai'} />}

        {!dualProvider && supportsSubscription && workspaceId && <div>
          <label htmlFor="credential-auth-method" className="block text-xs font-semibold mb-1.5">{t('authMethodLabel')}</label>
          <select id="credential-auth-method" value={authMethod} onChange={(event) => {
            setAuthMethod(event.target.value as 'api-key' | 'subscription'); setApiKeyInput(''); setKeyError(''); setTestResult(null);
          }} className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs">
            <option value="api-key">{t('authMethodApi')}</option>
            <option value="subscription">{t('authMethodSubscription')}</option>
          </select>
        </div>}

        {!dualProvider && authMethod === 'subscription' && workspaceId && supportsSubscription ? <>
          <SubscriptionSignIn key={keyProvider} workspaceId={workspaceId} provider={keyProvider} onConnected={handleClose} />
          <button type="button" onClick={handleClose} className="px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs">{t('cancel')}</button>
        </> : (!dualProvider && authMethod === 'subscription' ? null : <>

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
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <label htmlFor="key-secret-input" className="block text-xs font-semibold text-ink-700 dark:text-ink-300">
              {t('keySecretLabel')}
            </label>
            {multi && (
              <button
                type="button"
                aria-label={t('addKeyField')}
                title={fields.length >= MAX_PROVIDER_KEYS ? t('keyFieldLimit') : t('addKeyField')}
                disabled={fields.length >= MAX_PROVIDER_KEYS || isPending}
                onClick={addField}
                className="inline-flex items-center justify-center w-7 h-7 rounded-full border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          {multi ? (
            <div className="flex flex-col gap-2">
              {fields.map((field, index) => (
                <div key={field.id}>
                  <div className="flex items-center gap-2">
                    <input
                      id={index === 0 ? 'key-secret-input' : `key-secret-input-${index}`}
                      type="password"
                      required
                      autoComplete="off"
                      value={field.value}
                      aria-label={index === 0 ? undefined : `${t('keySecretLabel')} ${index + 1}`}
                      onChange={(e) => {
                        const value = e.target.value;
                        setFields((prev) =>
                          prev.map((item) => (item.id === field.id ? { ...item, value, result: null, testedValue: '' } : item)),
                        );
                        if (keyError) setKeyError('');
                      }}
                      placeholder={t('keySecretPlaceholder')}
                      className={`w-full px-3.5 py-2 rounded-full border text-xs font-mono focus:ring-2 focus:outline-hidden ${
                        keyError
                          ? 'border-red-500 focus:ring-red-500'
                          : 'border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:ring-brand-500'
                      }`}
                    />
                    {workspaceId && (
                      <button
                        type="button"
                        aria-label={`${t('testKeyAction')} ${index + 1}`}
                        disabled={field.testing || isPending || field.value.trim().length < 8}
                        onClick={() => void testField(field.id)}
                        className="shrink-0 px-3 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 disabled:opacity-50"
                      >
                        {field.testing ? t('testingKey') : t('testKeyAction')}
                      </button>
                    )}
                    {fields.length > 1 && (
                      <button
                        type="button"
                        aria-label={`${t('removeKeyField')} ${index + 1}`}
                        onClick={() => removeField(index)}
                        className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800"
                      >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {field.result && (
                    <p
                      role="status"
                      className={`text-xs mt-1 ms-2 ${outcomeColor(quotaOutcome(field.result))}`}
                    >
                      {outcomeText(field.result)}
                    </p>
                  )}
                </div>
              ))}
              {fields.length >= MAX_PROVIDER_KEYS && (
                <p className="text-[11px] text-ink-500 dark:text-ink-400 ms-2">{t('keyFieldLimit')}</p>
              )}
            </div>
          ) : (
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
          )}
          {keyError ? (
            <p className="text-xs text-red-500 mt-1 ms-2">{keyError}</p>
          ) : (
            <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('keySecretHelp')}</p>
          )}
        </div>

        <AddKeyModalFooter
          workspaceId={workspaceId}
          multi={multi}
          isTesting={isTesting}
          isPending={isPending}
          apiKeyInput={apiKeyInput}
          fields={fields}
          testResult={testResult}
          onTestBeforeSave={handleTestBeforeSave}
          onClose={handleClose}
          testReason={testReason}
        />
        </>)}
      </form>
    </Modal>
  );
}
