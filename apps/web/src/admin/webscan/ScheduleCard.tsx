import { useI18n } from '../../i18n/context.js';
import { SettingsCard } from './components.js';
import { ScheduleFields } from './ScheduleFields.js';
import type { ScheduleDraft } from './settings-draft.js';

/**
 * The default schedule of the global policy (ADR-0052 section 5).
 *
 * The hour and the minute are Kuwait time (`Asia/Kuwait`, UTC+3, no daylight
 * saving), and the card says so: the server keeps the rule as it is and
 * computes its first occurrence after the save.
 *
 * The card edits the draft of the rule and not the rule of the API: the
 * anchor of a rule of every two weeks belongs to the editing session, so it
 * survives the frequencies the administrator goes through on the way.
 */
export interface ScheduleCardProps {
  schedule: ScheduleDraft;
  onChange: (schedule: ScheduleDraft) => void;
}

export function ScheduleCard({ schedule, onChange }: ScheduleCardProps) {
  const { t } = useI18n();

  return (
    <SettingsCard title={t('webscanScheduleTitle')} hint={t('webscanScheduleKuwait')}>
      <ScheduleFields schedule={schedule} onChange={onChange} />
    </SettingsCard>
  );
}
