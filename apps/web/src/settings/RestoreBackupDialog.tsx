import { useState } from 'react';
import type {
  BACKUP_MAX_BYTES as SERVER_BACKUP_MAX_BYTES,
  BackupPreview,
  BackupSection,
} from '@mergepilot/app/contract';
import { ApiClientError } from '../api/client.js';
import { Modal } from '../components/Modal.js';
import { useI18n, type I18nContextValue } from '../i18n/context.js';
import { useProviderLabel } from './providers.js';
import { useRestoreBackup } from './useBackup.js';

// The server's BACKUP_MAX_BYTES (type-checked; the web never imports server runtime code).
const BACKUP_MAX_BYTES: typeof SERVER_BACKUP_MAX_BYTES = 1024 * 1024;

const SECTIONS: ReadonlyArray<{ id: BackupSection; label: 'backupSectionSettings' | 'backupSectionBots' | 'backupSectionCredentials' }> = [
  { id: 'settings', label: 'backupSectionSettings' },
  { id: 'bots', label: 'backupSectionBots' },
  { id: 'credentials', label: 'backupSectionCredentials' },
];

export interface RestoreBackupDialogProps {
  workspaceId: string;
  isOpen: boolean;
  onClose: () => void;
}

/** A refused restore as one line: the translated wrong-passphrase text, or the server's message and field. */
function errorText(err: unknown, t: I18nContextValue['t']): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'bad_passphrase') return t('backupBadPassphrase');
    if (err.code === 'file_too_large') return t('backupFileTooLarge');
    return err.message;
  }
  return err instanceof Error ? err.message : t('error');
}

/** Reads a picked file as text (FileReader works in every browser and in jsdom). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** Pick a file, preview the dry-run diff, then confirm the restore (ADR-0018). */
export function RestoreBackupDialog({ workspaceId, isOpen, onClose }: RestoreBackupDialogProps) {
  const { t } = useI18n();
  const providerLabel = useProviderLabel();
  const restore = useRestoreBackup(workspaceId);
  const [file, setFile] = useState<unknown>(null);
  const [passphrase, setPassphrase] = useState('');
  const [sections, setSections] = useState<BackupSection[]>(SECTIONS.map((s) => s.id));
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPreview(null);
    setError(null);
  };
  const close = () => {
    setFile(null);
    setPassphrase('');
    setSections(SECTIONS.map((s) => s.id));
    reset();
    onClose();
  };

  const handleFile = async (picked: File | undefined) => {
    reset();
    setFile(null);
    if (!picked) return;
    if (picked.size > BACKUP_MAX_BYTES) return setError(t('backupFileTooLarge'));
    try {
      setFile(JSON.parse(await readText(picked)) as unknown);
    } catch {
      setError(t('backupFileInvalid'));
    }
  };

  const run = async (dryRun: boolean) => {
    setError(null);
    try {
      const result = await restore.mutateAsync({ file, passphrase: passphrase || undefined, dryRun, sections });
      if (dryRun) setPreview(result);
      else close();
    } catch (err) {
      setPreview(null);
      setError(errorText(err, t));
    }
  };

  const handleConfirm = () => {
    if (window.confirm(t('backupRestoreConfirmQuestion'))) void run(false);
  };

  const toggle = (id: BackupSection, on: boolean) => {
    reset();
    setSections((prev) => (on ? SECTIONS.map((s) => s.id).filter((s) => s === id || prev.includes(s)) : prev.filter((s) => s !== id)));
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={t('backupRestoreDialogTitle')} description={t('backupRestoreDialogDesc')}>
      <div className="flex flex-col gap-4 mt-2 max-h-[70vh] overflow-y-auto">
        <div>
          <label htmlFor="backup-restore-file" className="block text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">
            {t('backupChooseFile')}
          </label>
          <input
            id="backup-restore-file"
            type="file"
            accept="application/json,.json"
            onChange={(e) => void handleFile(e.target.files?.[0])}
            className="block w-full text-xs text-ink-700 dark:text-ink-300"
          />
        </div>
        <div>
          <label htmlFor="backup-restore-passphrase" className="block text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">
            {t('backupRestorePassphrase')}
          </label>
          <input
            id="backup-restore-passphrase"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => {
              reset();
              setPassphrase(e.target.value);
            }}
            className="w-full px-3.5 py-2 rounded-full border border-ink-300 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 text-sm focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
          />
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-semibold mb-1 text-ink-700 dark:text-ink-300">{t('backupSectionsLabel')}</legend>
          {SECTIONS.map((s) => (
            <label key={s.id} className="inline-flex items-center gap-2 text-xs text-ink-700 dark:text-ink-300">
              <input type="checkbox" checked={sections.includes(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
              {t(s.label)}
            </label>
          ))}
        </fieldset>

        {error && (
          <p role="alert" className="p-3 rounded-[10px] bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-300 text-xs">
            {error}
          </p>
        )}

        {preview && (
          <section aria-label={t('backupPreviewTitle')} className="p-3 rounded-[10px] border border-ink-200 dark:border-ink-700 text-xs flex flex-col gap-1.5">
            <h3 className="font-semibold text-ink-900 dark:text-ink-100">{t('backupPreviewTitle')}</h3>
            {preview.sections.includes('settings') && (
              <p dir="auto">
                {preview.settingsChanged.length > 0
                  ? t('backupPreviewSettings', { fields: preview.settingsChanged.join(', ') })
                  : t('backupPreviewNoSettings')}
              </p>
            )}
            {preview.sections.includes('bots') && <p>{t('backupPreviewBots', { count: preview.bots })}</p>}
            {preview.credentials.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {preview.credentials.map((c) => (
                  <li key={c.provider}>
                    {providerLabel(c.provider)} <span className="font-mono">••••{c.last4}</span> —{' '}
                    {t(c.action === 'add' ? 'backupPreviewKeyAdd' : 'backupPreviewKeyReplace')}
                  </li>
                ))}
              </ul>
            )}
            {preview.sections.includes('credentials') && (
              <p className="text-amber-700 dark:text-amber-300">{t('backupPreviewKeysNotTested')}</p>
            )}
          </section>
        )}

        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 mt-2">
          <button
            type="button"
            onClick={close}
            className="px-4 py-2 rounded-full border border-ink-300 dark:border-ink-700 text-xs font-medium text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void run(true)}
            disabled={file === null || sections.length === 0 || restore.isPending}
            className="px-4 py-2 rounded-full border border-brand-600 text-brand-700 dark:text-brand-300 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold"
          >
            {restore.isPending && !preview ? t('backupPreviewing') : t('backupPreview')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!preview || restore.isPending}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-full text-xs font-semibold transition-colors"
          >
            {restore.isPending && preview ? t('backupRestoring') : t('backupRestoreConfirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
