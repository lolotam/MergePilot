import type { JudgeUse } from '@mergepilot/app/contract';
import { useI18n } from '../i18n/context.js';
import type { I18nKey } from '../i18n/ar.js';
import { labelClass } from './providers.js';

/** The four uses, in the order the API stores them (ADR-0015 multi-use). */
export const JUDGE_USES: readonly JudgeUse[] = ['annotate', 'filter', 'dedupe', 'consensus'];

/** Ticked by the card when the judge is switched on with no uses, so "Enable" alone does something. */
export const DEFAULT_ENABLED_USES: readonly JudgeUse[] = ['annotate', 'dedupe'];

const LABELS: Record<JudgeUse, { label: I18nKey; hint: I18nKey }> = {
  annotate: { label: 'judgeUseAnnotate', hint: 'judgeUseAnnotateHint' },
  filter: { label: 'judgeUseFilter', hint: 'judgeUseFilterHint' },
  dedupe: { label: 'judgeUseDedupe', hint: 'judgeUseDedupeHint' },
  consensus: { label: 'judgeUseConsensus', hint: 'judgeUseConsensusHint' },
};

export interface JudgeUsesFieldProps {
  value: readonly JudgeUse[];
  disabled: boolean;
  onChange: (uses: JudgeUse[]) => void;
}

/** One checkbox per use, each with a one-line hint; any combination, none included. */
export function JudgeUsesField({ value, disabled, onChange }: JudgeUsesFieldProps) {
  const { t } = useI18n();
  const toggle = (use: JudgeUse, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(use);
    else next.delete(use);
    onChange(JUDGE_USES.filter((u) => next.has(u)));
  };
  return (
    <fieldset className="md:col-span-2">
      <legend className={labelClass}>{t('judgeUsesLabel')}</legend>
      <p className="text-[11px] text-ink-500 dark:text-ink-400 mb-2">{t('judgeUsesHint')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {JUDGE_USES.map((use) => (
          <label
            key={use}
            className="flex items-start gap-2 p-2.5 rounded-xl border border-ink-200 dark:border-ink-800 text-xs text-ink-800 dark:text-ink-200"
          >
            <input
              type="checkbox"
              checked={value.includes(use)}
              disabled={disabled}
              onChange={(e) => toggle(use, e.target.checked)}
              aria-describedby={`judge-use-${use}-hint`}
              className="mt-0.5 w-4 h-4 accent-brand-600 shrink-0"
            />
            <span className="min-w-0">
              <span className="font-semibold">{t(LABELS[use].label)}</span>
              <span id={`judge-use-${use}-hint`} className="block text-[11px] text-ink-500 dark:text-ink-400 mt-0.5 leading-relaxed">
                {t(LABELS[use].hint)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
