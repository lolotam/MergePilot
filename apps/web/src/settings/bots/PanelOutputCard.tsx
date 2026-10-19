import { Users } from 'lucide-react';
import type { PanelMode } from '../../api/bots.js';
import type { I18nKey } from '../../i18n/ar.js';
import { useI18n } from '../../i18n/context.js';
import { fieldClass, labelClass } from '../providers.js';
import { settingsPatch, usePatchSettings, useWorkspaceSettings } from '../useSettingsPatch.js';
import { MAX_BOTS } from './BotLogo.js';

export interface PanelOutputCardProps {
  workspaceId: string;
  isMember: boolean;
  /** Whether at least one extra bot is active (the panel only matters then). */
  hasActiveExtraBot: boolean;
}

const MODES: ReadonlyArray<{ mode: PanelMode; label: I18nKey }> = [
  { mode: 'separate', label: 'panelModeSeparate' },
  { mode: 'consensus', label: 'panelModeConsensus' },
];
const AGREEMENT_CHOICES = Array.from({ length: MAX_BOTS }, (_, i) => i + 1);

/** «مخرجات اللوحة»: each bot posts its own review, or one consensus review (ADR-0017). */
export function PanelOutputCard({ workspaceId, isMember, hasActiveExtraBot }: PanelOutputCardProps) {
  const { t } = useI18n();
  const settings = useWorkspaceSettings(workspaceId).data?.settings;
  const patch = usePatchSettings(workspaceId, 'panelSaved');
  const mode: PanelMode = settings?.panelMode ?? 'separate';
  const minAgreement = settings?.panelMinAgreement ?? 1;
  const disabled = isMember || !settings || patch.isPending;

  return (
    <section
      aria-labelledby="panel-output-title"
      className="p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          <div>
            <h2 id="panel-output-title" className="text-base font-bold text-ink-900 dark:text-ink-100">
              {t('panelCardTitle')}
            </h2>
            <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">{t('panelCardDesc')}</p>
            {!hasActiveExtraBot && (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">{t('panelNoActiveBots')}</p>
            )}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={labelClass}>{t('panelModeLabel')}</legend>
            {MODES.map(({ mode: value, label }) => (
              <label key={value} className="flex items-center gap-2 text-xs text-ink-800 dark:text-ink-200 cursor-pointer">
                <input
                  type="radio"
                  name="panel-mode"
                  value={value}
                  checked={mode === value}
                  disabled={disabled}
                  onChange={() => { if (settings) patch.mutate(settingsPatch(settings, { panelMode: value })); }}
                  className="w-4 h-4 text-brand-600 focus:ring-brand-500 border-ink-300 dark:border-ink-700"
                />
                <span>{t(label)}</span>
              </label>
            ))}
          </fieldset>

          {mode === 'consensus' && (
            <div className="sm:w-64">
              <label htmlFor="panel-min-agreement" className={labelClass}>
                {t('panelMinAgreementLabel')}
              </label>
              <select
                id="panel-min-agreement"
                value={String(minAgreement)}
                disabled={disabled}
                onChange={(e) => {
                  if (settings) patch.mutate(settingsPatch(settings, { panelMinAgreement: Number(e.target.value) }));
                }}
                className={fieldClass}
              >
                {AGREEMENT_CHOICES.map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-ink-500 dark:text-ink-400 mt-1 ms-2">{t('panelMinAgreementHint')}</p>
            </div>
          )}
          {!settings ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('retentionNeedsSettings')}</p> : null}
        </div>
      </div>
    </section>
  );
}
