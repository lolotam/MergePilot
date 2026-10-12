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
import { PageHeader } from '../components/PageHeader.js';

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
    <div className="flex flex-col gap-6 max-w-5xl">
      <PageHeader
        title={t('reposTitle')}
        subtitle={t('reposDesc')}
        action={
          ghData?.installUrl ? (
            <a
              href={ghData.installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium text-xs rounded-full shadow-xs transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>{t('installGitHubApp')}</span>
              <ExternalLink className="w-3.5 h-3.5 ms-1 opacity-70" />
            </a>
          ) : undefined
        }
      />

      {/* GitHub Account Linking Banner if not linked */}
      {!isGitHubLinked && (
        <div className="p-6 rounded-[10px] border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xs">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-amber-900 dark:text-amber-100">
                {t('linkGitHubAccount')}
              </h2>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                {t('linkGitHubAccountDesc')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLinkSocial}
            className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white font-medium text-xs rounded-full transition-colors shrink-0"
          >
            {t('linkGitHubAccountButton')}
          </button>
        </div>
      )}

      {/* Linked Installations List */}
      <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
            {t('linkedInstallationsTitle')}
          </h2>
        </div>

        {linkedLoading ? (
          <div className="py-6 text-sm text-ink-400">{t('loading')}</div>
        ) : linkedList.length === 0 ? (
          <div className="py-8 text-center text-xs text-ink-500 dark:text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-[10px]">
            {t('noLinkedInstallations')}
          </div>
        ) : (
          <div className="divide-y divide-ink-100 dark:divide-ink-800">
            {linkedList.map((inst) => (
              <div key={inst.id} className="py-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
                    <FolderGit2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-xs text-ink-900 dark:text-ink-100">{inst.accountLogin}</h3>
                    <div className="flex items-center gap-2 text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">
                      <span>{inst.accountType === 'Organization' ? t('accountTypeOrg') : t('accountTypeUser')}</span>
                      <span>•</span>
                      <span>{inst.repositorySelection === 'all' ? t('repoScopeAll') : t('repoScopeSelected')}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
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
        <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
              <GitBranch className="w-4 h-4" />
            </div>
            <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
              {t('availableInstallationsTitle')}
            </h2>
          </div>

          {ghLoading ? (
            <div className="py-6 text-sm text-ink-400">{t('loading')}</div>
          ) : availableList.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-500 dark:text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-[10px]">
              {t('noAvailableInstallations')}
            </div>
          ) : (
            <div className="divide-y divide-ink-100 dark:divide-ink-800">
              {availableList.map((inst) => (
                <div key={inst.id} className="py-4 flex items-center justify-between gap-4">
                  <div>
                    <h3 className="font-semibold text-xs text-ink-900 dark:text-ink-100">{inst.accountLogin}</h3>
                    <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-0.5">
                      {inst.accountType === 'Organization' ? t('accountTypeOrg') : t('accountTypeUser')} • {inst.repositorySelection === 'all' ? t('repoScopeAll') : t('repoScopeSelected')}
                    </p>
                  </div>

                  {!isMember && (
                    <button
                      type="button"
                      onClick={() => handleLinkToWorkspace(inst.id)}
                      disabled={linkMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-full text-xs font-medium transition-colors"
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
