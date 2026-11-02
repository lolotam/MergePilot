import type { WebScanSchedule } from '@mergepilot/app/contract';
import { useI18n } from '../../i18n/context.js';
import { SettingsCard } from './components.js';
import { ScheduleFields } from './ScheduleFields.js';
import { toSchedule, toScheduleDraft } from './settings-draft.js';

/**
 * The default schedule of the global policy (ADR-0052 section 5).
 *
 * The hour and the minute are Kuwait time (`Asia/Kuwait`, UTC+3, no daylight
 * saving), and the card says so: the server keeps the rule as it is and
 * computes its first occurrence after the save.
 */
export interface ScheduleCardProps {
  schedule: WebScanSchedule;
  onChange: (schedule: WebScanSchedule) => void;
}

export function ScheduleCard({ schedule, onChange }: ScheduleCardProps) {
  const { t } = useI18n();

  return (
    <SettingsCard title={t('webscanScheduleTitle')} hint={t('webscanScheduleKuwait')}>
      <ScheduleFields
        schedule={toScheduleDraft(schedule)}
        onChange={(draft) => onChange(toSchedule(draft))}
      />
    </SettingsCard>
  );
}
