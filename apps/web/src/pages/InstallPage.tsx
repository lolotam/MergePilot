import { useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { CheckCircle2, GitPullRequest, ArrowRight, ShieldAlert } from 'lucide-react';
import { useMeQuery } from '../api/hooks.js';
import { api } from '../api/client.js';
import { useI18n } from '../i18n/context.js';
import { useToast } from '../components/Toast.js';

export function InstallPage() {
  const [searchParams] = useSearchParams();
  const installationIdStr = searchParams.get('installation_id') ?? '';
  const installationId = Number.parseInt(installationIdStr, 10);

  const { t } = useI18n();
  const { showToast } = useToast();
  const { data: meData, isLoading } = useMeQuery();

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [linkedSuccess, setLinkedSuccess] = useState(false);

  // Filter workspaces: only those where user is admin or owner
  const adminWorkspaces =
    meData?.workspaces.filter((w) => w.role === 'admin' || w.role === 'owner') ?? [];

  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWorkspaceId || Number.isNaN(installationId)) return;

    setIsSubmitting(true);
    try {
      await api.linkInstallation(selectedWorkspaceId, installationId);
      setLinkedSuccess(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('error');
      showToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!installationIdStr || Number.isNaN(installationId)) {
    return (
      <div className="max-w-md mx-auto my-12 p-8 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs text-center">
        <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h1 className="font-serif text-xl font-bold mb-2 text-ink-900 dark:text-ink-100">{t('missingInstallId')}</h1>
        <Link to="/" className="inline-block mt-2 text-xs font-semibold text-brand-700 dark:text-brand-400 hover:underline">
          {t('goToWorkspaceDashboard')}
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-sm text-ink-400">{t('loading')}</div>
      </div>
    );
  }

  if (linkedSuccess) {
    return (
      <div className="max-w-md mx-auto my-12 p-8 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs text-center animate-in fade-in">
        <div className="w-12 h-12 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-6 h-6" />
        </div>
        <h1 className="font-serif text-2xl font-bold mb-2 text-ink-900 dark:text-ink-100">
          {t('installSuccessTitle')}
        </h1>
        <p className="text-xs sm:text-sm text-ink-500 dark:text-ink-400 mb-6 font-sans">
          {t('installSuccessDesc')}
        </p>
        <Link
          to={`/w/${selectedWorkspaceId}`}
          className="inline-flex items-center justify-center gap-2 w-full py-2.5 px-5 bg-brand-600 hover:bg-brand-700 text-white rounded-full font-medium text-xs transition-colors"
        >
          <span>{t('goToWorkspaceDashboard')}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto my-12 p-8 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <GitPullRequest className="w-5 h-5" />
        </div>
        <div>
          <h1 className="font-serif text-xl font-bold text-ink-900 dark:text-ink-100">{t('installTitle')}</h1>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('installDesc')}</p>
        </div>
      </div>

      <div className="mb-5 p-3 rounded-[10px] bg-ink-50 dark:bg-ink-800/60 border border-ink-200/60 dark:border-ink-800 text-xs font-mono text-ink-700 dark:text-ink-300">
        <span>{t('installIdLabel')}: </span>
        <span className="font-bold text-brand-700 dark:text-brand-300">{installationId}</span>
      </div>

      {adminWorkspaces.length === 0 ? (
        <div className="p-5 rounded-[10px] bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-center">
          <p className="font-semibold text-xs text-amber-800 dark:text-amber-200">
            {t('noAdminWorkspacesTitle')}
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t('noAdminWorkspacesDesc')}
          </p>
          <Link to="/" className="inline-block mt-3 text-xs font-semibold text-brand-700 dark:text-brand-400 hover:underline">
            {t('createWorkspace')}
          </Link>
        </div>
      ) : (
        <form onSubmit={handleLink} className="flex flex-col gap-4">
          <div>
            <label htmlFor="workspace-select" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
              {t('chooseWorkspaceLabel')}
            </label>
            <select
              id="workspace-select"
              required
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 text-xs focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              <option value="">{t('selectWorkspacePlaceholder')}</option>
              {adminWorkspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.role === 'owner' ? t('roleOwner') : t('roleAdmin')})
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !selectedWorkspaceId}
            className="w-full py-2.5 px-5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full font-medium text-xs transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden mt-2"
          >
            {isSubmitting ? t('linkingInstallation') : t('linkWorkspaceAction')}
          </button>
        </form>
      )}
    </div>
  );
}
