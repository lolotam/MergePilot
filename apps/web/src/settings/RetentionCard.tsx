import { History } from 'lucide-react';
import type { Settings } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import { usePatchSettings, useWorkspaceSettings } from './useSettingsPatch.js';

type Retention = Settings['runRetentionDays'];

// The server's RUN_RETENTION_CHOICES (type-checked; the web never imports server runtime code).
const CHOICES = [30, 90, 180, 365] as const satisfies ReadonlyArray<NonNullable<Retention>>;

const LABELS = {
  30: 'retention30',
  90: 'retention90',
  180: 'retention180',
  365: 'retention365',
} as const;

interface RetentionCardProps {
  workspaceId: string;
  isMember: boolean;
}

/** «احتفظ بسجل المراجعات لمدة» — 30 / 90 / 180 / 365 days or forever (ADR-0014). */
export function RetentionCard({ workspaceId, isMember }: RetentionCardProps) {
  const { t } = useI18n();
  const settings = useWorkspaceSettings(workspaceId).data?.settings;
  const patch = usePatchSettings(workspaceId, 'retentionSaved');
  const value: Retention = settings ? (settings.runRetentionDays === undefined ? 30 : settings.runRetentionDays) : 30;
  const disabled = isMember || !settings || patch.isPending;

  return (
    <div className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <History className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <label htmlFor="run-retention" className="text-base font-bold text-ink-900 dark:text-ink-100">
            {t('retentionTitle')}
          </label>
          <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{t('retentionDesc')}</p>
          <select
            id="run-retention"
            value={value === null ? 'forever' : String(value)}
            disabled={disabled}
            onChange={(e) => {
              const next: Retention = e.target.value === 'forever' ? null : (Number(e.target.value) as NonNullable<Retention>);
              patch.mutate({ runRetentionDays: next });
            }}
            className="mt-3 w-full sm:w-56 px-3 py-2 text-sm rounded-md border border-ink-200 dark:border-ink-700 bg-white dark:bg-ink-800 text-ink-900 dark:text-ink-100 focus:outline-hidden focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
          >
            {CHOICES.map((days) => (
              <option key={days} value={String(days)}>
                {t(LABELS[days])}
              </option>
            ))}
            <option value="forever">{t('retentionForever')}</option>
          </select>
          {!settings ? <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">{t('retentionNeedsSettings')}</p> : null}
        </div>
      </div>
    </div>
  );
}
