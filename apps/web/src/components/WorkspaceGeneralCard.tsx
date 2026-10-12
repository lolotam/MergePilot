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
    <div className="p-6 bg-white dark:bg-ink-900 rounded-xl border border-gray-200 dark:border-ink-800 shadow-xs">
      <h2 className="text-base font-semibold flex items-center gap-2">
        <Building2 className="w-5 h-5 text-brand-600 dark:text-brand-400" />
        <span>{t('workspaceGeneralTitle')}</span>
      </h2>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-4">{t('workspaceGeneralDesc')}</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="workspace-name" className="block text-sm font-medium mb-1">
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
            className={`w-full px-3 py-2 rounded-lg border text-sm focus:ring-2 focus:outline-hidden disabled:opacity-60 ${
              nameError
                ? 'border-red-500 focus:ring-red-500'
                : 'border-gray-300 dark:border-ink-700 bg-white dark:bg-ink-800 focus:ring-brand-500'
            }`}
          />
          {nameError && <p className="text-xs text-red-500 mt-1">{nameError}</p>}
        </div>

        {!isMember && (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={renameMutation.isPending}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium rounded-lg text-sm transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {renameMutation.isPending ? t('renamingWorkspace') : t('renameWorkspaceButton')}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
