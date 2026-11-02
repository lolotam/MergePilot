import { useId } from 'react';
import type { WebScanSettingsDto } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { SettingsCard, Toggle, inputClass } from './components.js';
import type { SettingsDraft } from './settings-draft.js';

/**
 * The alerts, the contact and the retention of the global policy
 * (ADR-0052 section 5).
 *
 * The alerts open an issue only from the given severity and validation, so an
 * indicator alone never opens one.
 */
const SEVERITIES = [
  { value: 'critical', label: 'webscanSeverityCritical' },
  { value: 'high', label: 'webscanSeverityHigh' },
  { value: 'medium', label: 'webscanSeverityMedium' },
  { value: 'low', label: 'webscanSeverityLow' },
  { value: 'info', label: 'webscanSeverityInfo' },
] as const satisfies readonly { value: WebScanSettingsDto['alertMinSeverity']; label: string }[];

const VALIDATIONS = [
  { value: 'Confirmed', label: 'webscanValidationConfirmed' },
  { value: 'Likely', label: 'webscanValidationLikely' },
  { value: 'Indicator', label: 'webscanValidationIndicator' },
  { value: 'Informational', label: 'webscanValidationInformational' },
] as const satisfies readonly { value: WebScanSettingsDto['alertMinValidation']; label: string }[];

/** The severity of a select, without trusting the browser. */
function toSeverity(value: string): WebScanSettingsDto['alertMinSeverity'] {
  const found = SEVERITIES.find((option) => option.value === value);
  return found ? found.value : 'high';
}

/** The validation of a select, without trusting the browser. */
function toValidation(value: string): WebScanSettingsDto['alertMinValidation'] {
  const found = VALIDATIONS.find((option) => option.value === value);
  return found ? found.value : 'Likely';
}

export interface AlertsCardProps {
  draft: SettingsDraft;
  onChange: (draft: SettingsDraft) => void;
}

export function AlertsCard({ draft, onChange }: AlertsCardProps) {
  const { t } = useI18n();
  const enabledId = useId();
  const severityId = useId();
  const validationId = useId();
  const contactId = useId();
  const retentionId = useId();

  return (
    <SettingsCard title={t('webscanAlertsTitle')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex items-center gap-2 sm:col-span-2">
          <Toggle
            checked={draft.alertsEnabled}
            label={t('webscanAlertsEnabled')}
            describedBy={enabledId}
            onChange={(alertsEnabled) => onChange({ ...draft, alertsEnabled })}
          />
          <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">
            {t('webscanAlertsEnabled')}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={severityId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanAlertMinSeverity')}
          </label>
          <select
            id={severityId}
            value={draft.alertMinSeverity}
            onChange={(e) => onChange({ ...draft, alertMinSeverity: toSeverity(e.target.value) })}
            className={inputClass}
          >
            {SEVERITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={validationId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanAlertMinValidation')}
          </label>
          <select
            id={validationId}
            value={draft.alertMinValidation}
            onChange={(e) => onChange({ ...draft, alertMinValidation: toValidation(e.target.value) })}
            className={inputClass}
          >
            {VALIDATIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={contactId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanContactLabel')}
          </label>
          <input
            id={contactId}
            type="text"
            value={draft.contact}
            onChange={(e) => onChange({ ...draft, contact: e.target.value })}
            aria-describedby={`${contactId}-hint`}
            className={inputClass}
          />
          <p id={`${contactId}-hint`} className="text-[11px] text-ink-500 dark:text-ink-400">
            {t('webscanContactHint')}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={retentionId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanRetentionLabel')}
          </label>
          <input
            id={retentionId}
            type="number"
            inputMode="numeric"
            value={draft.retentionDays}
            onChange={(e) => onChange({ ...draft, retentionDays: Number(e.target.value) })}
            aria-describedby={`${retentionId}-hint`}
            className={inputClass}
          />
          <p id={`${retentionId}-hint`} className="text-[11px] text-ink-500 dark:text-ink-400">
            {t('webscanRetentionHint')}
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}
