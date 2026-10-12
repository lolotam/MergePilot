import { useState } from 'react';
import type { RepoColorKey } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import { RepoChip, RepoColorPopover } from './RepoColorPicker.js';
import { repoColor, type RepoColorOverrides } from './repo-colors.js';

interface RepoLegendProps {
  repos: string[];
  overrides: RepoColorOverrides | undefined;
  /** Admin/owner with saved settings: a chip opens the color picker. */
  canEdit: boolean;
  onPick: (repo: string, color: RepoColorKey | null) => void;
}

/** The repos on the current page with their colors; admins change a color in place. */
export function RepoLegend({ repos, overrides, canEdit, onPick }: RepoLegendProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (repos.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500 dark:text-ink-400">
      <span className="font-semibold">{t('repoColorsLegend')}:</span>
      <ul aria-label={t('repoColorsLegend')} className="flex flex-wrap items-center gap-1.5">
        {repos.map((repo) => {
          const color = repoColor(repo, overrides);
          return (
            <li key={repo} className="relative">
              {canEdit ? (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={open === repo}
                  aria-label={t('repoColorChange', { repo })}
                  onClick={() => setOpen(open === repo ? null : repo)}
                  className="rounded-full focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <RepoChip repo={repo} color={color} className="hover:brightness-95" />
                </button>
              ) : (
                <RepoChip repo={repo} color={color} />
              )}
              {open === repo ? (
                <RepoColorPopover
                  repo={repo}
                  selected={overrides?.[repo]}
                  onClose={() => setOpen(null)}
                  onPick={(c) => {
                    setOpen(null);
                    onPick(repo, c);
                  }}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
