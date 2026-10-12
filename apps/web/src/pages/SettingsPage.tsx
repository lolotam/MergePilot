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
import { PageHeader } from '../components/PageHeader.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
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

  const handleAddKeySubmit = async (prov: ApiProvider, apiKey: string) => {
    try {
      await saveKeyMutation.mutateAsync({
        provider: prov,
        apiKey,
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
    <div className="flex flex-col gap-6 max-w-4xl">
      <PageHeader title={t('settingsTitle')} subtitle={t('settingsDesc')} />

      {isMember && (
        <div className="flex items-center gap-3 p-4 rounded-[10px] bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-xs">
          <ShieldAlert className="w-5 h-5 shrink-0" />
          <span>{t('memberReadOnlyBanner')}</span>
        </div>
      )}

      {currentWorkspace && (
        <WorkspaceGeneralCard workspaceId={workspaceId} workspaceName={currentWorkspace.name} isMember={isMember} />
      )}

      {/* Review Settings Section */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <Sliders className="w-4 h-4" />
          </div>
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('settingsTitle')}</h2>
        </div>

        {settingsLoading ? (
          <div className="py-4 text-sm text-ink-400">{t('loading')}</div>
        ) : (
          <form onSubmit={handleSettingsSubmit} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="settings-provider" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                  {t('providerLabel')}
                </label>
                <select
                  id="settings-provider"
                  disabled={isMember}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as ApiProvider)}
                  className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
                >
                  <option value="anthropic">{t('providerAnthropic') || 'Anthropic'}</option>
                  <option value="openai">{t('providerOpenai') || 'OpenAI'}</option>
                  <option value="gemini">{t('providerGemini') || 'Google Gemini'}</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-model" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                  {t('modelLabel')}
                </label>
                <input
                  id="settings-model"
                  type="text"
                  disabled={isMember}
                  value={model}
                  onChange={(e) => { setModel(e.target.value); if (modelError) setModelError(''); }}
                  placeholder={t('modelPlaceholder')}
                  className={`w-full px-3.5 py-2 rounded-full border text-xs focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
                    modelError
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:ring-brand-500'
                  }`}
                />
                {modelError && <p className="text-xs text-red-500 mt-1 ms-2">{modelError}</p>}
              </div>

              <div>
                <label htmlFor="settings-language" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
                  {t('languageLabel')}
                </label>
                <select
                  id="settings-language"
                  disabled={isMember}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as 'ar' | 'en')}
                  className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-xs text-ink-900 dark:text-ink-100 focus:ring-2 focus:ring-brand-500 focus:outline-hidden disabled:opacity-60"
                >
                  <option value="ar">{t('langArabic')}</option>
                  <option value="en">{t('langEnglish')}</option>
                </select>
              </div>

              <div>
                <label htmlFor="settings-budget" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
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
                  className={`w-full px-3.5 py-2 rounded-full border text-xs focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
                    budgetError
                      ? 'border-red-500 focus:ring-red-500'
                      : 'border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:ring-brand-500'
                  }`}
                />
                {budgetError && <p className="text-xs text-red-500 mt-1 ms-2">{budgetError}</p>}
              </div>
            </div>

            {!isMember && (
              <div className="flex justify-end mt-2">
                <button
                  type="submit"
                  disabled={updateSettingsMutation.isPending}
                  className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium rounded-full text-xs transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
                >
                  {updateSettingsMutation.isPending ? t('saving') : t('saveSettingsButton')}
                </button>
              </div>
            )}
          </form>
        )}
      </div>

      {/* API Keys Section */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('apiKeysTitle')}</h2>
              <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('apiKeysDesc')}</p>
            </div>
          </div>
          {!isMember && (
            <button
              type="button"
              onClick={() => setAddKeyModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('addKeyButton')}</span>
            </button>
          )}
        </div>

        {keysLoading ? (
          <div className="py-4 text-sm text-ink-400">{t('loading')}</div>
        ) : !keysData?.keys || keysData.keys.length === 0 ? (
          <div className="py-6 text-center text-xs text-ink-500 dark:text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-[10px]">
            {t('noKeysConfigured')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead>
                <tr className="border-b border-ink-200 dark:border-ink-800 text-[11px] text-ink-500 dark:text-ink-400">
                  <th className="py-2.5 px-3 text-start font-semibold">{t('keyProviderCol')}</th>
                  <th className="py-2.5 px-3 text-start font-semibold">{t('keyLast4Col')}</th>
                  <th className="py-2.5 px-3 text-start font-semibold">{t('keyCreatedByCol')}</th>
                  <th className="py-2.5 px-3 text-start font-semibold">{t('keyCreatedAtCol')}</th>
                  {!isMember && <th className="py-2.5 px-3 text-end font-semibold">{t('actions')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800/50">
                {keysData.keys.map((k) => (
                  <tr key={k.provider} className="hover:bg-ink-50/50 dark:hover:bg-ink-800/40">
                    <td className="py-2.5 px-3 font-semibold text-ink-900 dark:text-ink-100 capitalize">{k.provider}</td>
                    <td className="py-2.5 px-3 font-mono text-xs">••••{k.last4}</td>
                    <td className="py-2.5 px-3 text-xs text-ink-500 dark:text-ink-400 truncate max-w-[150px]">
                      {k.createdBy}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-ink-500 dark:text-ink-400">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    {!isMember && (
                      <td className="py-2.5 px-3 text-end">
                        <button
                          type="button"
                          onClick={() => handleDeleteKey(k.provider)}
                          disabled={deleteKeyMutation.isPending}
                          className="p-1.5 rounded-full text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                          aria-label={t('delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
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

      <AddKeyModal
        isOpen={addKeyModalOpen}
        onClose={() => setAddKeyModalOpen(false)}
        onSubmit={handleAddKeySubmit}
        isPending={saveKeyMutation.isPending}
      />
    </div>
  );
}
