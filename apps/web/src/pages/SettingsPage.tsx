import { useState } from 'react';
import { useParams } from 'react-router';
import { KeyRound, ShieldAlert, Trash2, Plus } from 'lucide-react';
import type { Settings } from '@mergepilot/app/contract';
import type { ApiProvider, KeyProvider } from '../api/client.js';
import {
  useMeQuery,
  useSettingsQuery,
  useUpdateSettingsMutation,
  useKeysQuery,
  useSaveKeyMutation,
  useDeleteKeyMutation,
  useDisconnectSubscriptionMutation,
  useSetProviderDefaultMethodMutation,
} from '../api/hooks.js';
import type { KeyItem } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { PageHeader } from '../components/PageHeader.js';
import { AddKeyModal } from '../components/AddKeyModal.js';
import { WorkspaceGeneralCard } from '../components/WorkspaceGeneralCard.js';
import { WorkspaceDangerZone } from '../components/WorkspaceDangerZone.js';
import { BackupCard } from '../settings/BackupCard.js';
import { ReviewerPanel } from '../settings/bots/ReviewerPanel.js';
import { SkillsCard } from '../settings/skills/SkillsCard.js';
import { RepoColorsCard } from '../settings/RepoColorsCard.js';
import { RetentionCard } from '../settings/RetentionCard.js';
import { JudgeCard } from '../settings/JudgeCard.js';
import { PricesCard } from '../settings/PricesCard.js';
import { JudgeTestButton } from '../settings/JudgeTestButton.js';
import { TestKeyButton } from '../settings/TestKeyButton.js';
import { isJudgeKeyOnly, useProviderLabel } from '../settings/providers.js';

export function SettingsPage() {
  const { workspaceId = '' } = useParams();
  const { t } = useI18n();
  const providerLabel = useProviderLabel();

  const { data: meData } = useMeQuery();
  const { data: settingsData, isLoading: settingsLoading } = useSettingsQuery(workspaceId);
  const { data: keysData, isLoading: keysLoading } = useKeysQuery(workspaceId);

  const updateSettingsMutation = useUpdateSettingsMutation(workspaceId);
  const saveKeyMutation = useSaveKeyMutation(workspaceId);
  const deleteKeyMutation = useDeleteKeyMutation(workspaceId);
  const defaultMethodMutation = useSetProviderDefaultMethodMutation(workspaceId);
  const disconnectSubscriptionMutation = useDisconnectSubscriptionMutation(workspaceId);

  const isDualProviderRow = (k: KeyItem) => k.hasSubscription !== undefined;
  /** The row shows a subscription: the dual row's own flag, else the stored method. */
  const showsSubscription = (k: KeyItem) => (isDualProviderRow(k) ? k.hasSubscription === true : k.authMethod === 'subscription');

  const currentWorkspace = meData?.workspaces.find((w) => w.id === workspaceId);
  const isMember = currentWorkspace?.role === 'member';

  const [addKeyModalOpen, setAddKeyModalOpen] = useState(false);
  // Heavy-duty and fallback models may only use providers with a saved key (members cannot list keys).
  const savedKeys = isMember || !keysData ? undefined : keysData.keys.map((k) => k.provider);
  // Jev-only key types (ADR-0015) never serve as review providers.
  const keyedProviders = savedKeys?.filter((p): p is ApiProvider => !isJudgeKeyOnly(p));

  const handleSettingsSave = async (updatedSettings: Settings) => {
    if (isMember) return;
    await updateSettingsMutation.mutateAsync(updatedSettings);
  };

  const handleAddKeySubmit = async (prov: KeyProvider, apiKey: string, baseUrl?: string, apiKeys?: string[]) => {
    try {
      await saveKeyMutation.mutateAsync({
        provider: prov,
        apiKey,
        baseUrl: baseUrl || undefined,
        ...(apiKeys ? { apiKeys } : {}),
      });
      setAddKeyModalOpen(false);
    } catch {
      // Error handled by mutation toast
    }
  };

  const handleDeleteKey = async (prov: KeyProvider) => {
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

      {/* Review settings, one tab per reviewer bot, then the panel output (ADR-0017) */}
      <ReviewerPanel
        workspaceId={workspaceId}
        settings={settingsData?.settings}
        isLoading={settingsLoading}
        isMember={isMember}
        onSave={handleSettingsSave}
        isSaving={updateSettingsMutation.isPending}
        keyedProviders={keyedProviders}
      />

      {/* Markdown review skills; each bot tab picks one (ADR-0034) */}
      <SkillsCard workspaceId={workspaceId} isMember={isMember} />

      <JudgeCard workspaceId={workspaceId} isMember={isMember} keyedProviders={savedKeys} />
      <PricesCard workspaceId={workspaceId} isMember={isMember} />

      <RetentionCard workspaceId={workspaceId} isMember={isMember} />
      <RepoColorsCard workspaceId={workspaceId} isMember={isMember} />

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
                    <td className="py-2.5 px-3 font-semibold text-ink-900 dark:text-ink-100">
                      <div className="flex flex-col">
                        <span>{providerLabel(k.provider)}</span>
                        {k.baseUrl && (
                          <span dir="ltr" className="text-[10px] text-ink-400 font-mono truncate max-w-[200px]">
                            {k.baseUrl}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs">
                      {isDualProviderRow(k) ? (
                        <div className="flex flex-col gap-1 font-sans">
                          {k.hasSubscription && <span>{t('authMethodSubscription')}</span>}
                          {k.keys?.map((slot) => <span key={slot.id}>••••{slot.last4}</span>)}
                          {!k.hasSubscription && !k.keys?.length && (k.authMethod === 'unknown' ? t('authMethodUnknown') : `••••${k.last4}`)}
                        </div>
                      ) : k.authMethod === 'subscription' ? t('authMethodSubscription') : k.authMethod === 'unknown' ? t('authMethodUnknown') : `••••${k.last4}`}
                      {/* The provider refused the subscription's refresh (ADR-0037): sign in again. */}
                      {k.signInRequiredAt && showsSubscription(k) && (
                        <div role="alert" className="mt-1 rounded-[8px] border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-2 py-1 font-sans text-[11px] text-amber-800 dark:text-amber-300">
                          <span>{t('subscriptionSignInRequired')}</span>
                          {!isMember && (
                            <button
                              type="button"
                              onClick={() => setAddKeyModalOpen(true)}
                              className="px-2 py-1 mt-1 rounded-full border border-ink-300 dark:border-ink-700 text-[11px]"
                            >
                              {t('subscriptionSignInAgain')}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-ink-500 dark:text-ink-400 truncate max-w-[150px]">
                      {k.createdBy}
                    </td>
                    <td className="py-2.5 px-3 text-xs text-ink-500 dark:text-ink-400">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    {!isMember && (
                      <td className="py-2.5 px-3 text-end">
                        <div className="inline-flex flex-wrap items-center gap-2 justify-end">
                          {isDualProviderRow(k) && k.hasSubscription && (k.keys?.length ?? 0) > 0 && (
                            <select
                              aria-label={t('defaultMethodLabel')}
                              className="px-2 py-1 rounded-full border border-ink-300 dark:border-ink-700 text-[11px]"
                              value={k.defaultMethod ?? 'subscription'}
                              disabled={defaultMethodMutation.isPending}
                              onChange={(e) => defaultMethodMutation.mutate({ provider: k.provider, method: e.target.value as 'subscription' | 'api-key' })}
                            >
                              <option value="subscription">{t('defaultMethodSubscription')}</option>
                              <option value="api-key">{t('defaultMethodApiKey')}</option>
                            </select>
                          )}
                          {isDualProviderRow(k) && k.hasSubscription && (
                            <button
                              type="button"
                              className="px-2 py-1 rounded-full border border-ink-300 dark:border-ink-700 text-[11px]"
                              disabled={disconnectSubscriptionMutation.isPending}
                              onClick={() => {
                                if (window.confirm(t('disconnectSubscriptionConfirm', { provider: providerLabel(k.provider) }))) {
                                  disconnectSubscriptionMutation.mutate(k.provider);
                                }
                              }}
                            >
                              {t('disconnectSubscription')}
                            </button>
                          )}
                          {isJudgeKeyOnly(k.provider) ? (
                            <JudgeTestButton workspaceId={workspaceId} provider={k.provider} disabled={isMember} />
                          ) : (
                            <TestKeyButton workspaceId={workspaceId} provider={k.provider} disabled={isMember} />
                          )}
                          <button
                            type="button"
                            onClick={() => handleDeleteKey(k.provider)}
                            disabled={deleteKeyMutation.isPending}
                            className="p-1.5 rounded-full text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                            aria-label={t('delete')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {currentWorkspace && <BackupCard workspaceId={workspaceId} role={currentWorkspace.role} />}

      {currentWorkspace && (
        <WorkspaceDangerZone workspaceId={workspaceId} workspaceName={currentWorkspace.name} role={currentWorkspace.role} />
      )}

      <AddKeyModal
        isOpen={addKeyModalOpen}
        onClose={() => setAddKeyModalOpen(false)}
        onSubmit={handleAddKeySubmit}
        isPending={saveKeyMutation.isPending}
        workspaceId={workspaceId}
      />
    </div>
  );
}
