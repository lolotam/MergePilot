import { useState } from 'react';
import { ArchiveRestore, Download, ShieldCheck, Upload } from 'lucide-react';
import type { MIN_PASSPHRASE_LENGTH as SERVER_MIN_PASSPHRASE } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import { RestoreBackupDialog } from './RestoreBackupDialog.js';
import { useExportBackup } from './useBackup.js';

export interface BackupCardProps {
  workspaceId: string;
  role: 'owner' | 'admin' | 'member';
}

// The server's MIN_PASSPHRASE_LENGTH (type-checked; the web never imports server runtime code).
const MIN_PASSPHRASE_LENGTH: typeof SERVER_MIN_PASSPHRASE = 12;

const inputClass =
  'w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 text-sm focus:ring-2 focus:ring-brand-500 focus:outline-hidden';

/**
 * «النسخة الاحتياطية والاسترجاع» (ADR-0018): owners download every setting, the bots and the
 * passphrase-sealed keys as a JSON file, and restore one. Hidden for admins and members.
 */
export function BackupCard({ workspaceId, role }: BackupCardProps) {
  const { t } = useI18n();
  const exportBackup = useExportBackup(workspaceId);
  const [includeKeys, setIncludeKeys] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [restoreOpen, setRestoreOpen] = useState(false);

  if (role !== 'owner') return null;

  const tooShort = includeKeys && passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = includeKeys && confirm.length > 0 && confirm !== passphrase;
  const ready = !includeKeys || (passphrase.length >= MIN_PASSPHRASE_LENGTH && confirm === passphrase);

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    try {
      await exportBackup.mutateAsync(includeKeys ? { includeKeys, passphrase } : { includeKeys });
      setPassphrase('');
      setConfirm('');
    } catch {
      // Error handled by the mutation toast
    }
  };

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <ArchiveRestore className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-ink-900 dark:text-ink-100">{t('backupCardTitle')}</h2>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{t('backupCardDesc')}</p>
          <p className="flex items-start gap-2 mt-3 p-3 rounded-[10px] bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-xs leading-relaxed">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>{t('backupKeysWarning')}</span>
          </p>

          <form onSubmit={handleExport} className="flex flex-col gap-3 mt-4">
            <h3 className="text-sm font-semibold text-ink-800 dark:text-ink-200">{t('backupExportTitle')}</h3>
            <label className="inline-flex items-center gap-2 text-xs text-ink-700 dark:text-ink-300">
              <input type="checkbox" checked={includeKeys} onChange={(e) => setIncludeKeys(e.target.checked)} />
              {t('backupIncludeKeys')}
            </label>
            {includeKeys && (
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="backup-passphrase" className="block text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">
                    {t('backupPassphrase')}
                  </label>
                  <input
                    id="backup-passphrase"
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    className={inputClass}
                  />
                  <p className={`text-[11px] mt-1 ${tooShort ? 'text-red-600 dark:text-red-400' : 'text-ink-400'}`}>
                    {tooShort
                      ? t('backupPassphraseTooShort', { min: MIN_PASSPHRASE_LENGTH })
                      : t('backupPassphraseHint', { min: MIN_PASSPHRASE_LENGTH })}
                  </p>
                </div>
                <div>
                  <label htmlFor="backup-passphrase-confirm" className="block text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">
                    {t('backupPassphraseConfirm')}
                  </label>
                  <input
                    id="backup-passphrase-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className={inputClass}
                  />
                  {mismatch && (
                    <p role="alert" className="text-[11px] mt-1 text-red-600 dark:text-red-400">
                      {t('backupPassphraseMismatch')}
                    </p>
                  )}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2.5">
              <button
                type="submit"
                disabled={!ready || exportBackup.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-full text-xs font-semibold transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{exportBackup.isPending ? t('backupDownloading') : t('backupDownload')}</span>
              </button>
              <button
                type="button"
                onClick={() => setRestoreOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-semibold text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{t('backupRestoreButton')}</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      <RestoreBackupDialog workspaceId={workspaceId} isOpen={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </div>
  );
}
