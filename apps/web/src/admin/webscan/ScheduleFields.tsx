import { useId } from 'react';
import { useI18n } from '../../i18n/context.js';
import { Toggle, inputClass } from './components.js';
import { SCHEDULE_FREQUENCY_KEYS } from './schedule-labels.js';
import type { ScheduleDraft, ScheduleFrequency } from './settings-draft.js';

/**
 * The schedule fields of the site form and of the global policy
 * (ADR-0052 section 5).
 *
 * The frequency decides which day field is shown, and the time is Kuwait time
 * (`Asia/Kuwait`, UTC+3, no daylight saving).
 */
const FREQUENCIES = [
  { value: 'daily', label: SCHEDULE_FREQUENCY_KEYS.daily },
  { value: 'weekly', label: SCHEDULE_FREQUENCY_KEYS.weekly },
  { value: 'biweekly', label: SCHEDULE_FREQUENCY_KEYS.biweekly },
  { value: 'monthly', label: SCHEDULE_FREQUENCY_KEYS.monthly },
] as const satisfies readonly { value: ScheduleFrequency; label: string }[];

/** The days of the week, as the contract numbers them. */
const WEEKDAYS = [
  { value: 0, label: 'webscanWeekday0' },
  { value: 1, label: 'webscanWeekday1' },
  { value: 2, label: 'webscanWeekday2' },
  { value: 3, label: 'webscanWeekday3' },
  { value: 4, label: 'webscanWeekday4' },
  { value: 5, label: 'webscanWeekday5' },
  { value: 6, label: 'webscanWeekday6' },
] as const;

/** The frequency of a select, without trusting the browser. */
function toFrequency(value: string): ScheduleFrequency {
  return value === 'weekly' || value === 'biweekly' || value === 'monthly' ? value : 'daily';
}

export interface ScheduleFieldsProps {
  schedule: ScheduleDraft;
  onChange: (schedule: ScheduleDraft) => void;
}

export function ScheduleFields({ schedule, onChange }: ScheduleFieldsProps) {
  const { t } = useI18n();
  const frequencyId = useId();
  const weekdayId = useId();
  const dayOfMonthId = useId();
  const hourId = useId();
  const minuteId = useId();

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={frequencyId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
          {t('webscanScheduleFrequency')}
        </label>
        <select
          id={frequencyId}
          value={schedule.frequency}
          onChange={(e) => onChange({ ...schedule, frequency: toFrequency(e.target.value) })}
          className={inputClass}
        >
          {FREQUENCIES.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </div>

      {(schedule.frequency === 'weekly' || schedule.frequency === 'biweekly') && (
        <div className="flex flex-col gap-1">
          <label htmlFor={weekdayId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanScheduleWeekday')}
          </label>
          <select
            id={weekdayId}
            value={schedule.weekday}
            onChange={(e) => onChange({ ...schedule, weekday: Number(e.target.value) })}
            className={inputClass}
          >
            {WEEKDAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {t(day.label)}
              </option>
            ))}
          </select>
        </div>
      )}

      {schedule.frequency === 'monthly' && (
        <div className="flex flex-col gap-1">
          <label htmlFor={dayOfMonthId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
            {t('webscanScheduleDayOfMonth')}
          </label>
          <input
            id={dayOfMonthId}
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={schedule.dayOfMonth}
            onChange={(e) => onChange({ ...schedule, dayOfMonth: Number(e.target.value) })}
            className={inputClass}
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={hourId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
          {t('webscanScheduleHour')}
        </label>
        <input
          id={hourId}
          type="number"
          inputMode="numeric"
          min={0}
          max={23}
          value={schedule.hour}
          onChange={(e) => onChange({ ...schedule, hour: Number(e.target.value) })}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={minuteId} className="text-xs font-semibold text-ink-800 dark:text-ink-100">
          {t('webscanScheduleMinute')}
        </label>
        <input
          id={minuteId}
          type="number"
          inputMode="numeric"
          min={0}
          max={59}
          value={schedule.minute}
          onChange={(e) => onChange({ ...schedule, minute: Number(e.target.value) })}
          className={inputClass}
        />
      </div>

      <div className="flex items-center gap-2">
        <Toggle
          checked={schedule.enabled}
          label={t('webscanScheduleEnabled')}
          onChange={(enabled) => onChange({ ...schedule, enabled })}
        />
        <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">
          {t('webscanScheduleEnabled')}
        </span>
      </div>
    </div>
  );
}
