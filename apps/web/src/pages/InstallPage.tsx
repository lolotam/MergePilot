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
      <div className="max-w-md mx-auto my-12 p-6 bg-white dark:bg-gray-800 rounded-xl shadow-md border border-gray-200 dark:border-gray-700 text-center">
        <ShieldAlert className="w-12 h-12 text-amber-500 mx-auto mb-3" />
        <h1 className="text-lg font-bold mb-2">{t('missingInstallId')}</h1>
        <Link to="/" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
          {t('goToWorkspaceDashboard')}
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-sm text-gray-500">{t('loading')}</div>
      </div>
    );
  }

  if (linkedSuccess) {
    return (
      <div className="max-w-md mx-auto my-12 p-8 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 text-center animate-in fade-in">
        <div className="p-3 bg-green-100 dark:bg-green-900/50 rounded-full text-green-600 dark:text-green-400 w-16 h-16 flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-10 h-10" />
        </div>
        <h1 className="text-2xl font-bold mb-2 text-gray-900 dark:text-gray-100">
          {t('installSuccessTitle')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          {t('installSuccessDesc')}
        </p>
        <Link
          to={`/w/${selectedWorkspaceId}`}
          className="inline-flex items-center justify-center gap-2 w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium text-sm transition-colors"
        >
          <span>{t('goToWorkspaceDashboard')}</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto my-12 p-8 bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 bg-blue-100 dark:bg-blue-900/50 rounded-xl text-blue-600 dark:text-blue-400">
          <GitPullRequest className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-lg font-bold">{t('installTitle')}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('installDesc')}</p>
        </div>
      </div>

      <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg text-xs font-mono text-gray-600 dark:text-gray-300">
        <span>{t('installIdLabel')}: </span>
        <span className="font-bold">{installationId}</span>
      </div>

      {adminWorkspaces.length === 0 ? (
        <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-center">
          <p className="font-semibold text-sm text-amber-800 dark:text-amber-200">
            {t('noAdminWorkspacesTitle')}
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            {t('noAdminWorkspacesDesc')}
          </p>
          <Link to="/" className="inline-block mt-4 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline">
            {t('createWorkspace')}
          </Link>
        </div>
      ) : (
        <form onSubmit={handleLink} className="flex flex-col gap-4">
          <div>
            <label htmlFor="workspace-select" className="block text-sm font-medium mb-1">
              {t('chooseWorkspaceLabel')}
            </label>
            <select
              id="workspace-select"
              required
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-hidden"
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
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors focus:ring-2 focus:ring-blue-500 focus:outline-hidden mt-2"
          >
            {isSubmitting ? t('linkingInstallation') : t('linkWorkspaceAction')}
          </button>
        </form>
      )}
    </div>
  );
}
