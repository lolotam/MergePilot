import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useDeleteWorkspaceMutation } from '../api/hooks.js';
import { useI18n } from '../i18n/context.js';
import { Modal } from './Modal.js';

export interface WorkspaceDangerZoneProps {
  workspaceId: string;
  workspaceName: string;
  role: 'owner' | 'admin' | 'member';
}

export function WorkspaceDangerZone({ workspaceId, workspaceName, role }: WorkspaceDangerZoneProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const deleteMutation = useDeleteWorkspaceMutation(workspaceId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  if (role !== 'owner') return null;

  const nameMatches = confirmName.trim() === workspaceName;

  const closeDialog = () => {
    setDialogOpen(false);
    setConfirmName('');
  };

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameMatches) return;
    try {
      await deleteMutation.mutateAsync(confirmName.trim());
      closeDialog();
      navigate('/');
    } catch {
      // Error handled by mutation toast
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-red-200 dark:border-red-900/60 shadow-xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-base font-bold text-red-700 dark:text-red-400">
              {t('dangerZoneTitle')}
            </h2>
            <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{t('dangerZoneDesc')}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-red-500 focus:outline-hidden shrink-0"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>{t('deleteWorkspaceButton')}</span>
        </button>
      </div>

      <Modal
        isOpen={dialogOpen}
        onClose={closeDialog}
        title={t('deleteWorkspaceModalTitle')}
        description={t('deleteWorkspaceModalDesc')}
      >
        <form onSubmit={handleDelete} className="flex flex-col gap-4 mt-2">
          <ul className="flex flex-col gap-2 text-xs">
            <li className="p-3 rounded-[10px] bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-300">
              {t('deleteWorkspaceWhatIsDeleted')}
            </li>
            <li className="p-3 rounded-[10px] bg-brand-50 dark:bg-brand-950/40 border border-brand-200 dark:border-brand-900 text-brand-800 dark:text-brand-300">
              {t('deleteWorkspaceWhatIsKept')}
            </li>
          </ul>

          <div>
            <label htmlFor="delete-workspace-confirm" className="block text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">
              {t('deleteWorkspaceConfirmPrompt')}{' '}
              <span className="font-mono font-bold" dir="auto">{workspaceName}</span>
            </label>
            <input
              id="delete-workspace-confirm"
              type="text"
              autoComplete="off"
              dir="auto"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={t('deleteWorkspaceConfirmPlaceholder')}
              className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 text-sm focus:ring-2 focus:ring-red-500 focus:outline-hidden"
            />
          </div>

          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 mt-2">
            <button
              type="button"
              onClick={closeDialog}
              className="px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={!nameMatches || deleteMutation.isPending}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-red-500 focus:outline-hidden"
            >
              {deleteMutation.isPending ? t('deletingWorkspace') : t('deleteWorkspaceConfirmButton')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
