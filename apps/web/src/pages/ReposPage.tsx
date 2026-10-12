import { useParams } from 'react-router';
import {
  FolderGit2,
  ExternalLink,
  Plus,
  GitBranch,
  ShieldCheck,
  AlertTriangle,
  Link as LinkIcon,
} from 'lucide-react';
import {
  useMeQuery,
  useInstallationsQuery,
  useGitHubInstallationsQuery,
  useLinkInstallationMutation,
} from '../api/hooks.js';
import { authClient } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';

export function ReposPage() {
  const { workspaceId = '' } = useParams();
  const { t } = useI18n();

  const { data: meData } = useMeQuery();
  const { data: linkedData, isLoading: linkedLoading } = useInstallationsQuery(workspaceId);

  const isGitHubLinked = Boolean(meData?.user?.githubLinked);
  const { data: ghData, isLoading: ghLoading } = useGitHubInstallationsQuery(isGitHubLinked);

  const linkMutation = useLinkInstallationMutation(workspaceId);

  const currentWorkspace = meData?.workspaces.find((w) => w.id === workspaceId);
  const isMember = currentWorkspace?.role === 'member';

  const handleLinkSocial = async () => {
    await authClient.linkSocial({
      provider: 'github',
      callbackURL: window.location.href,
    });
  };

  const handleLinkToWorkspace = async (installationId: number) => {
    if (isMember) return;
    await linkMutation.mutateAsync(installationId);
  };

  const linkedList = linkedData?.installations ?? [];
  const linkedIds = new Set(linkedList.map((i) => i.id));
  const availableList = ghData?.installations?.filter((i) => !linkedIds.has(i.id)) ?? [];

  return (
    <div className="flex flex-col gap-8 max-w-5xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 dark:text-ink-100">
            {t('reposTitle')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('reposDesc')}</p>
        </div>

        {ghData?.installUrl && (
          <a
            href={ghData.installUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-ink-900 dark:bg-ink-100 text-white dark:text-ink-900 hover:bg-ink-800 dark:hover:bg-ink-200 font-medium text-sm rounded-lg shadow-xs transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>{t('installGitHubApp')}</span>
            <ExternalLink className="w-3.5 h-3.5 ms-1 opacity-70" />
          </a>
        )}
      </div>

      {/* GitHub Account Linking Banner if not linked */}
      {!isGitHubLinked && (
        <div className="p-6 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xs">
          <div>
            <h2 className="text-base font-bold text-amber-900 dark:text-amber-100 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              <span>{t('linkGitHubAccount')}</span>
            </h2>
            <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
              {t('linkGitHubAccountDesc')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLinkSocial}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-medium text-sm rounded-lg transition-colors shrink-0"
          >
            {t('linkGitHubAccountButton')}
          </button>
        </div>
      )}

      {/* Linked Installations List */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
        <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-green-600 dark:text-green-400" />
          <span>{t('linkedInstallationsTitle')}</span>
        </h2>

        {linkedLoading ? (
          <div className="py-6 text-sm text-gray-400">{t('loading')}</div>
        ) : linkedList.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-ink-800 rounded-lg">
            {t('noLinkedInstallations')}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-ink-800">
            {linkedList.map((inst) => (
              <div key={inst.id} className="py-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400">
                    <FolderGit2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm">{inst.accountLogin}</h3>
                    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      <span>{inst.accountType === 'Organization' ? t('accountTypeOrg') : t('accountTypeUser')}</span>
                      <span>•</span>
                      <span>{inst.repositorySelection === 'all' ? t('repoScopeAll') : t('repoScopeSelected')}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                    {t('active')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Available Installations from GitHub */}
      {isGitHubLinked && (
        <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
          <h2 className="text-base font-semibold mb-4 flex items-center gap-2">
            <GitBranch className="w-5 h-5 text-brand-600 dark:text-brand-400" />
            <span>{t('availableInstallationsTitle')}</span>
          </h2>

          {ghLoading ? (
            <div className="py-6 text-sm text-gray-400">{t('loading')}</div>
          ) : availableList.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-ink-800 rounded-lg">
              {t('noAvailableInstallations')}
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-ink-800">
              {availableList.map((inst) => (
                <div key={inst.id} className="py-4 flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-semibold text-sm">{inst.accountLogin}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {inst.accountType === 'Organization' ? t('accountTypeOrg') : t('accountTypeUser')} • {inst.repositorySelection === 'all' ? t('repoScopeAll') : t('repoScopeSelected')}
                    </p>
                  </div>

                  {!isMember && (
                    <button
                      type="button"
                      onClick={() => handleLinkToWorkspace(inst.id)}
                      disabled={linkMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      <LinkIcon className="w-3.5 h-3.5" />
                      <span>{t('linkToWorkspaceButton')}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
