import { useState, useEffect } from 'react';
import { useParams } from 'react-router';
import { KeyRound, ShieldAlert, Trash2, Plus, Sliders } from 'lucide-react';
import type { Settings } from '@mergepilot/app/contract';
import type { ApiProvider } from '../api/client.js';
import {
  useMeQuery,
  useSettingsQuery,
  useUpdateSettingsMutation,
  useKeysQuery,
  useSaveKeyMutation,
  useDeleteKeyMutation,
} from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { Modal } from '../components/Modal.js';
import { WorkspaceGeneralCard } from '../components/WorkspaceGeneralCard.js';
import { WorkspaceDangerZone } from '../components/WorkspaceDangerZone.js';

export function SettingsPage() {
  const { workspaceId = '' } = useParams();
  const { t } = useI18n();

  const { data: meData } = useMeQuery();
  const { data: settingsData, isLoading: settingsLoading } = useSettingsQuery(workspaceId);
  const { data: keysData, isLoading: keysLoading } = useKeysQuery(workspaceId);

  const updateSettingsMutation = useUpdateSettingsMutation(workspaceId);
  const saveKeyMutation = useSaveKeyMutation(workspaceId);
  const deleteKeyMutation = useDeleteKeyMutation(workspaceId);

  const currentWorkspace = meData?.workspaces.find((w) => w.id === workspaceId);
  const isMember = currentWorkspace?.role === 'member';

  const [provider, setProvider] = useState<ApiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [monthlyBudget, setMonthlyBudget] = useState('');

  const [modelError, setModelError] = useState('');
  const [budgetError, setBudgetError] = useState('');

  const [addKeyModalOpen, setAddKeyModalOpen] = useState(false);
  const [keyProvider, setKeyProvider] = useState<ApiProvider>('anthropic');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyError, setKeyError] = useState('');

  const closeAddKeyModal = () => {
    setAddKeyModalOpen(false);
    setApiKeyInput('');
    setKeyError('');
  };

  useEffect(() => {
    if (settingsData?.settings) {
      setProvider(settingsData.settings.provider);
      setModel(settingsData.settings.model);
      setLanguage(settingsData.settings.language);
      setMonthlyBudget(
        settingsData.settings.monthlyBudgetUsd !== null ? String(settingsData.settings.monthlyBudgetUsd) : '',
      );
    }
  }, [settingsData]);

  const handleSettingsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMember) return;

    let hasError = false;
    setModelError('');
    setBudgetError('');

    if (!model.trim()) {
      setModelError(t('modelRequired'));
      hasError = true;
    }

    let parsedBudget: number | null = null;
    if (monthlyBudget.trim()) {
      const num = Number(monthlyBudget.trim());
      if (Number.isNaN(num) || num <= 0) {
        setBudgetError(t('budgetMustBePositive'));
        hasError = true;
      } else {
        parsedBudget = num;
      }
    }

    if (hasError) return;
    await updateSettingsMutation.mutateAsync({
      provider,
      model: model.trim(),
      language,
      monthlyBudgetUsd: parsedBudget,
    } as Settings);
  };

  const handleAddKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError('');

    if (apiKeyInput.length < 8) {
      setKeyError(t('keySecretMinLength'));
      return;
    }

    const secretToSave = apiKeyInput;
    setApiKeyInput('');

    try {
      await saveKeyMutation.mutateAsync({
        provider: keyProvider,
        apiKey: secretToSave,
      });
      setAddKeyModalOpen(false);
    } catch {
      // Error handled by mutation toast
    }
  };

  const handleDeleteKey = async (prov: ApiProvider) => {
    if (isMember) return;
    if (window.confirm(t('deleteKeyConfirm', { provider: prov }))) {
      await deleteKeyMutation.mutateAsync(prov);
    }
  };

  return (
    <div className="flex flex-col gap-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-900 dark:text-ink-100">
          {t('settingsTitle')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('settingsDesc')}</p>
      </div>

      {isMember && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-sm">
          <ShieldAlert className="w-5 h-5 shrink-0" />
          <span>{t('memberReadOnlyBanner')}</span>
        </div>
      )}

      {currentWorkspace && (
        <WorkspaceGeneralCard workspaceId={workspaceId} workspaceName={currentWorkspace.name} isMember={isMember} />
      )}

      {/* Review Settings Section */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
          <Sliders className="w-5 h-5 text-brand-600 dark:text-brand-400" />
          <span>{t('settingsTitle')}</span>
        </h2>

        {settingsLoading ? (
          <div className="py-4 text-sm text-gray-400">{t('loading')}</div>
        ) : (
          <form onSubmit={handleSettingsSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="settings-provider" className="block text-sm font-medium mb-1">{t('providerLabel')}</label>
                <select
                  id="settings-provider"
                  disabled={isMember}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ApiProvider)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-sm focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
                >
                  <option value="anthropic">{t('providerAnthropic') || 'Anthropic'}</option>
                  <option value="openai">{t('providerOpenai') || 'OpenAI'}</option>
                  <option value="gemini">{t('providerGemini') || 'Google Gemini'}</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-model" className="block text-sm font-medium mb-1">{t('modelLabel')}</label>
                <input
                  id="settings-model"
                  type="text"
                  disabled={isMember}
                  value={model}
                  onChange={(e) => { setModel(e.target.value); if (modelError) setModelError(''); }}
                  placeholder={t('modelPlaceholder')}
                  className={`w-full px-3 py-2 rounded-lg border text-sm focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
                    modelError
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 focus:ring-brand-500'
                  }`}
                />
                {modelError && <p className="text-xs text-red-500 mt-1">{modelError}</p>}
              </div>

              <div>
                <label htmlFor="settings-language" className="block text-sm font-medium mb-1">{t('languageLabel')}</label>
                <select
                  id="settings-language"
                  disabled={isMember}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as 'ar' | 'en')}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-sm focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
                >
                  <option value="ar">{t('langArabic')}</option>
                  <option value="en">{t('langEnglish')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-budget" className="block text-sm font-medium mb-1">
                  {t('budgetLabel')}
                </label>
                <input
                  id="settings-budget"
                  type="text"
                  disabled={isMember}
                  value={monthlyBudget}
                  onChange={(e) => {
                    setMonthlyBudget(e.target.value);
                    if (budgetError) setBudgetError('');
                  }}
                  placeholder={t('budgetPlaceholder')}
                  className={`w-full px-3 py-2 rounded-lg border text-sm focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
                    budgetError
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 focus:ring-brand-500'
                  }`}
                />
                {budgetError && <p className="text-xs text-red-500 mt-1">{budgetError}</p>}
              </div>
            </div>

            {!isMember && (
              <div className="flex justify-end mt-2">
                <button
                  type="submit"
                  disabled={updateSettingsMutation.isPending}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
                >
                  {updateSettingsMutation.isPending ? t('saving') : t('saveSettingsButton')}
                </button>
              </div>
            )}
          </form>
        )}
      </div>

      {/* API Keys Section */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-brand-600 dark:text-brand-400" />
              <span>{t('apiKeysTitle')}</span>
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('apiKeysDesc')}</p>
          </div>
          {!isMember && (
            <button
              type="button"
              onClick={() => setAddKeyModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-xs font-medium transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Plus className="w-4 h-4" />
              <span>{t('addKeyButton')}</span>
            </button>
          )}
        </div>

        {keysLoading ? (
          <div className="py-4 text-sm text-gray-400">{t('loading')}</div>
        ) : !keysData?.keys || keysData.keys.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-ink-800 rounded-lg">
            {t('noKeysConfigured')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-ink-800 text-xs text-gray-500 dark:text-gray-400">
                  <th className="py-2.5 px-3 text-start">{t('keyProviderCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('keyLast4Col')}</th>
                  <th className="py-2.5 px-3 text-start">{t('keyCreatedByCol')}</th>
                  <th className="py-2.5 px-3 text-start">{t('keyCreatedAtCol')}</th>
                  {!isMember && <th className="py-2.5 px-3 text-end">{t('actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-ink-800/50">
                {keysData.keys.map((k) => (
                  <tr key={k.provider} className="hover:bg-gray-50/50 dark:hover:bg-ink-800/40">
                    <td className="py-2.5 px-3 font-medium capitalize">{k.provider}</td>
                    <td className="py-2.5 px-3 font-mono text-xs">••••{k.last4}</td>
                    <td className="py-2.5 px-3 text-xs text-gray-500 dark:text-gray-400 truncate max-w-[150px]">
                      {k.createdBy}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-gray-500 dark:text-gray-400">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    {!isMember && (
                      <td className="py-2.5 px-3 text-end">
                        <button
                          type="button"
                          onClick={() => handleDeleteKey(k.provider)}
                          disabled={deleteKeyMutation.isPending}
                          className="p-1 rounded text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                          aria-label={t('delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {currentWorkspace && (
        <WorkspaceDangerZone workspaceId={workspaceId} workspaceName={currentWorkspace.name} role={currentWorkspace.role} />
      )}

      {/* Add Key Modal */}
      <Modal
        isOpen={addKeyModalOpen}
        onClose={closeAddKeyModal}
        title={t('addKeyModalTitle')}
        description={t('addKeyModalDesc')}
      >
        <form onSubmit={handleAddKeySubmit} className="flex flex-col gap-4 mt-2">
          <div>
            <label htmlFor="key-provider-select" className="block text-sm font-medium mb-1">
              {t('keyProviderCol')}
            </label>
            <select
              id="key-provider-select"
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value as ApiProvider)}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-sm focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <option value="anthropic">{t('providerAnthropic') || 'Anthropic'}</option>
              <option value="openai">{t('providerOpenai') || 'OpenAI'}</option>
              <option value="gemini">{t('providerGemini') || 'Google Gemini'}</option>
            </select>
          </div>

          <div>
            <label htmlFor="key-secret-input" className="block text-sm font-medium mb-1">
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
              className={`w-full px-3 py-2 rounded-lg border text-sm font-mono focus:ring-2 focus:outline-hidden ${
                keyError
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 focus:ring-brand-500'
              }`}
            />
            {keyError ? (
              <p className="text-xs text-red-500 mt-1">{keyError}</p>
            ) : (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('keySecretHelp')}</p>
            )}
          </div>

          <div className="flex justify-end gap-3 mt-4">
            <button
              type="button"
              onClick={closeAddKeyModal}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-ink-700 text-sm font-medium hover:bg-gray-50 dark:hover:bg-ink-800 transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={saveKeyMutation.isPending || !apiKeyInput.trim()}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {saveKeyMutation.isPending ? t('savingKey') : t('saveKeyButton')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
