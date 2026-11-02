import type { WebScanSchedule } from '@mergepilot/app/contract';

/** The dictionary key of every schedule frequency. */
export const SCHEDULE_FREQUENCY_KEYS = {
  daily: 'webscanFrequencyDaily',
  weekly: 'webscanFrequencyWeekly',
  biweekly: 'webscanFrequencyBiweekly',
  monthly: 'webscanFrequencyMonthly',
} as const satisfies Record<WebScanSchedule['frequency'], string>;

/** The time of a schedule, as `hh:mm` in Kuwait time. */
export function scheduleTime(schedule: WebScanSchedule): string {
  const hour = String(schedule.hour).padStart(2, '0');
  const minute = String(schedule.minute).padStart(2, '0');
  return `${hour}:${minute}`;
}
