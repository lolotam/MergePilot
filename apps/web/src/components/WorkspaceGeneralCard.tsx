import { useEffect, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useRenameWorkspaceMutation } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';

const MAX_NAME_LENGTH = 60;

export interface WorkspaceGeneralCardProps {
  workspaceId: string;
  workspaceName: string;
  isMember: boolean;
}

export function WorkspaceGeneralCard({ workspaceId, workspaceName, isMember }: WorkspaceGeneralCardProps) {
  const { t } = useI18n();
  const renameMutation = useRenameWorkspaceMutation(workspaceId);

  const [name, setName] = useState(workspaceName);
  const [nameError, setNameError] = useState('');

  useEffect(() => {
    setName(workspaceName);
  }, [workspaceName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMember) return;

    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH) {
      setNameError(t('workspaceNameRequired'));
      return;
    }

    setNameError('');
    try {
      await renameMutation.mutateAsync(trimmed);
      setName(trimmed);
    } catch {
      // Error handled by mutation toast
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Building2 className="w-4 h-4" />
        </div>
        <div>
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">
            {t('workspaceGeneralTitle')}
          </h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('workspaceGeneralDesc')}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-4" noValidate>
        <div>
          <label htmlFor="workspace-name" className="block text-xs font-semibold mb-1.5 text-ink-700 dark:text-ink-300">
            {t('renameWorkspaceLabel')}
          </label>
          <input
            id="workspace-name"
            type="text"
            disabled={isMember}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError('');
            }}
            placeholder={t('renameWorkspacePlaceholder')}
            className={`w-full px-3.5 py-2 rounded-full border text-sm focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
              nameError
                ? 'border-red-500 focus:ring-red-500'
                : 'border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:ring-brand-500'
            }`}
          />
          {nameError && <p className="text-xs text-red-500 mt-1.5 ms-2">{nameError}</p>}
        </div>

        {!isMember && (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={renameMutation.isPending}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium rounded-full text-xs transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {renameMutation.isPending ? t('renamingWorkspace') : t('renameWorkspaceButton')}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
