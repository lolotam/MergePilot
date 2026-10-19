import { Palette } from 'lucide-react';
import { useRunReposQuery } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { RepoChip, RepoColorSwatches } from '../runs/RepoColorPicker.js';
import { repoColor } from '../runs/repo-colors.js';
import { settingsPatch, usePatchSettings, useWorkspaceSettings, withRepoColor } from './useSettingsPatch.js';

interface RepoColorsCardProps {
  workspaceId: string;
  isMember: boolean;
}

/** «ألوان الريبوهات»: a palette color per repository, or Auto (the hashed default). */
export function RepoColorsCard({ workspaceId, isMember }: RepoColorsCardProps) {
  const { t } = useI18n();
  const settings = useWorkspaceSettings(workspaceId).data?.settings;
  const { data: reposData } = useRunReposQuery(workspaceId);
  const patch = usePatchSettings(workspaceId, 'repoColorSaved');
  const colors = settings?.repoColors;
  const repos = [...new Set([...(reposData?.repos ?? []), ...Object.keys(colors ?? {})])].sort();
  const disabled = isMember || !settings;

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Palette className="w-4 h-4" />
        </div>
        <div>
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('repoColorsTitle')}</h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('repoColorsDesc')}</p>
          {!settings && !isMember ? (
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">{t('retentionNeedsSettings')}</p>
          ) : null}
        </div>
      </div>
      {repos.length === 0 ? (
        <div className="py-6 text-center text-xs text-ink-500 dark:text-ink-400 border border-dashed border-ink-200 dark:border-ink-800 rounded-[10px]">
          {t('repoColorsEmpty')}
        </div>
      ) : (
        <ul className="divide-y divide-ink-100 dark:divide-ink-800/60">
          {repos.map((repo) => (
            <li key={repo} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <RepoChip repo={repo} color={repoColor(repo, colors)} />
              <RepoColorSwatches
                repo={repo}
                selected={colors?.[repo]}
                disabled={disabled || patch.isPending}
                onPick={(color) => {
                  if (settings) patch.mutate(settingsPatch(
                    { ...settings, repoColors: colors ?? {} }, { repoColors: withRepoColor(colors, repo, color) },
                  ));
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
