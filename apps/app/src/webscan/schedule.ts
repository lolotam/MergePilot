import type { WebScanFrequency, WebScanSchedule } from './types.js';
import {
  addDays,
  daysInMonth,
  formatKuDate,
  kuwaitInstant,
  parseKuwaitLocalDate,
  toKuwait,
  weekdayOf,
  type KuDate,
} from './schedule-time.js';

/**
 * The schedule arithmetic of the scanner (ADR-0052 section 5).
 *
 * A schedule is a wall-clock rule: a frequency, a day and a time of day. Every
 * occurrence is computed in Kuwait time (`Asia/Kuwait`, UTC+3, no daylight saving), so
 * the rule does not depend on the time zone of the process that evaluates it.
 *
 * The next run is always strictly after the moment it is computed from, so a scheduler
 * that runs twice in the same slot never queues a second scan.
 *
 * This module is pure: it never touches storage, the network or the clock.
 */

export {
  KUWAIT_TIME_ZONE,
  KUWAIT_UTC_OFFSET_MINUTES,
  kuwaitLocalDate,
  parseKuwaitLocalDate,
} from './schedule-time.js';

const DAY_MS = 86_400_000;

/**
 * The anchor of a biweekly rule is the local date (`YYYY-MM-DD`, Kuwait time) the
 * frequency counts from. The biweekly occurrences are the anchor plus 14 days, 28 days
 * and so on. It lives on the persisted schedule itself, so a saved rule is evaluable
 * without a second shape.
 */

/** The default schedule of a new site: weekly on Friday at 04:00 Kuwait, switched off. */
export const DEFAULT_WEB_SCAN_SCHEDULE: WebScanSchedule = Object.freeze({
  frequency: 'weekly' as WebScanFrequency,
  weekday: 5,
  hour: 4,
  minute: 0,
  enabled: false,
});

/** Why a schedule was rejected. */
export type WebScanScheduleErrorCode =
  | 'invalid_shape'
  | 'invalid_frequency'
  | 'invalid_hour'
  | 'invalid_minute'
  | 'missing_weekday'
  | 'invalid_weekday'
  | 'missing_day_of_month'
  | 'invalid_day_of_month'
  | 'missing_anchor_date'
  | 'invalid_anchor_date'
  | 'weekday_anchor_mismatch';

/** A rejected schedule. The rejected value itself is never carried. */
export class WebScanScheduleError extends Error {
  readonly code: WebScanScheduleErrorCode;
  readonly field: string | undefined;

  constructor(code: WebScanScheduleErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'WebScanScheduleError';
    this.code = code;
    this.field = field;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The number of days between two occurrences of a frequency. */
export function frequencyIntervalDays(frequency: WebScanFrequency): number {
  switch (frequency) {
    case 'daily':
      return 1;
    case 'weekly':
      return 7;
    case 'biweekly':
      return 14;
    case 'monthly':
      return 30;
    default:
      throw new WebScanScheduleError('invalid_frequency', 'Unknown schedule frequency.', 'frequency');
  }
}

function normalizeWeekday(value: number): number {
  return ((value % 7) + 7) % 7;
}

/** The next daily occurrence strictly after `from`. */
function nextDailyRun(schedule: WebScanSchedule, from: Date): Date {
  const k = toKuwait(from);
  const today = kuwaitInstant(k.year, k.month, k.day, schedule.hour, schedule.minute);
  if (today.getTime() > from.getTime()) return today;
  const tomorrow = addDays(k, 1);
  return kuwaitInstant(tomorrow.year, tomorrow.month, tomorrow.day, schedule.hour, schedule.minute);
}

/** The next weekly occurrence strictly after `from`. */
function nextWeeklyRun(schedule: WebScanSchedule, from: Date): Date {
  const k = toKuwait(from);
  const target = normalizeWeekday(schedule.weekday ?? 0);
  const delta = (target - k.weekday + 7) % 7;
  let day = addDays(k, delta);
  let candidate = kuwaitInstant(day.year, day.month, day.day, schedule.hour, schedule.minute);
  if (candidate.getTime() <= from.getTime()) {
    day = addDays(day, 7);
    candidate = kuwaitInstant(day.year, day.month, day.day, schedule.hour, schedule.minute);
  }
  return candidate;
}

/**
 * The next biweekly occurrence strictly after `from`.
 *
 * The occurrences are the anchor plus a whole number of 14-day steps, so they always
 * fall on the weekday of the anchor.
 */
function nextBiweeklyRun(schedule: WebScanSchedule, from: Date): Date {
  const anchor = resolveAnchor(schedule);
  const anchorSlot = kuwaitInstant(anchor.year, anchor.month, anchor.day, schedule.hour, schedule.minute);
  const period = 14 * DAY_MS;
  const elapsed = from.getTime() - anchorSlot.getTime();
  const steps = elapsed >= 0 ? Math.floor(elapsed / period) + 1 : 0;
  const occurrence = addDays(anchor, 14 * steps);
  return kuwaitInstant(
    occurrence.year,
    occurrence.month,
    occurrence.day,
    schedule.hour,
    schedule.minute,
  );
}

/** The next monthly occurrence strictly after `from`. The day is clamped to the month. */
function nextMonthlyRun(schedule: WebScanSchedule, from: Date): Date {
  const day = schedule.dayOfMonth ?? 1;
  const k = toKuwait(from);
  let year = k.year;
  let month = k.month;
  // Every month has at least one day, so the loop returns within two steps.
  for (let step = 0; step < 24; step += 1) {
    const clamped = Math.min(day, daysInMonth(year, month));
    const candidate = kuwaitInstant(year, month, clamped, schedule.hour, schedule.minute);
    if (candidate.getTime() > from.getTime()) return candidate;
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  throw new WebScanScheduleError(
    'invalid_day_of_month',
    'The monthly day has no reachable occurrence.',
    'dayOfMonth',
  );
}

/** The anchor of a biweekly schedule. */
function resolveAnchor(schedule: WebScanSchedule): KuDate {
  if (schedule.anchorDate === undefined) {
    throw new WebScanScheduleError(
      'missing_anchor_date',
      'The biweekly frequency needs an anchor date.',
      'anchorDate',
    );
  }
  const parsed = parseKuwaitLocalDate(schedule.anchorDate);
  if (parsed === null) {
    throw new WebScanScheduleError(
      'invalid_anchor_date',
      'The anchor date must be a calendar date written as YYYY-MM-DD.',
      'anchorDate',
    );
  }
  return parsed;
}

/**
 * The next occurrence of the schedule strictly after `from`.
 *
 * The result is always later than `from`, so the same rule evaluated twice in one
 * slot never queues the same occurrence twice.
 */
export function nextScheduledRun(schedule: WebScanSchedule, from: Date): Date {
  switch (schedule.frequency) {
    case 'daily':
      return nextDailyRun(schedule, from);
    case 'weekly':
      return nextWeeklyRun(schedule, from);
    case 'biweekly':
      return nextBiweeklyRun(schedule, from);
    case 'monthly':
      return nextMonthlyRun(schedule, from);
    default:
      throw new WebScanScheduleError('invalid_frequency', 'Unknown schedule frequency.', 'frequency');
  }
}

/** The slot a schedule run belongs to: the Kuwait date of `from` at the scheduled time. */
export function scheduledSlot(schedule: WebScanSchedule, from: Date): Date {
  const k = toKuwait(from);
  return kuwaitInstant(k.year, k.month, k.day, schedule.hour, schedule.minute);
}

/** The options of a schedule that is being saved. */
export interface ParseScheduleOptions {
  /** The moment the schedule is saved. The default is the current time. */
  savedAt?: Date | undefined;
}

/**
 * Validates a submitted schedule and normalizes it.
 *
 * The frequency decides which fields are required: the daily frequency has no day
 * field, the weekly frequency needs a weekday, the biweekly frequency needs an anchor
 * date (and takes its weekday from it) and the monthly frequency needs a day of the
 * month between 1 and 31.
 *
 * A biweekly schedule that names a weekday but no anchor date is anchored on the
 * first matching weekday on or after the save time, so the two always agree.
 */
export function parseSchedule(input: unknown, options: ParseScheduleOptions = {}): WebScanSchedule {
  if (!isPlainObject(input)) {
    throw new WebScanScheduleError('invalid_shape', 'A schedule must be an object.');
  }

  const frequency = input['frequency'];
  if (
    frequency !== 'daily' &&
    frequency !== 'weekly' &&
    frequency !== 'biweekly' &&
    frequency !== 'monthly'
  ) {
    throw new WebScanScheduleError('invalid_frequency', 'Unknown schedule frequency.', 'frequency');
  }

  const hour = input['hour'];
  if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new WebScanScheduleError('invalid_hour', 'The hour must be between 0 and 23.', 'hour');
  }

  const minute = input['minute'];
  if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new WebScanScheduleError(
      'invalid_minute',
      'The minute must be between 0 and 59.',
      'minute',
    );
  }

  const enabled = input['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new WebScanScheduleError('invalid_shape', 'The enabled flag must be a boolean.', 'enabled');
  }

  const rawWeekday = input['weekday'];
  if (rawWeekday !== undefined && rawWeekday !== null) {
    if (
      typeof rawWeekday !== 'number' ||
      !Number.isInteger(rawWeekday) ||
      rawWeekday < 0 ||
      rawWeekday > 6
    ) {
      throw new WebScanScheduleError(
        'invalid_weekday',
        'The weekday must be between 0 (Sunday) and 6 (Saturday).',
        'weekday',
      );
    }
  }
  const weekday = rawWeekday === undefined || rawWeekday === null ? undefined : rawWeekday;

  const rawDayOfMonth = input['dayOfMonth'];
  if (rawDayOfMonth !== undefined && rawDayOfMonth !== null) {
    if (
      typeof rawDayOfMonth !== 'number' ||
      !Number.isInteger(rawDayOfMonth) ||
      rawDayOfMonth < 1 ||
      rawDayOfMonth > 31
    ) {
      throw new WebScanScheduleError(
        'invalid_day_of_month',
        'The day of the month must be between 1 and 31.',
        'dayOfMonth',
      );
    }
  }
  const dayOfMonth =
    rawDayOfMonth === undefined || rawDayOfMonth === null ? undefined : rawDayOfMonth;

  const rawAnchor = input['anchorDate'];
  if (rawAnchor !== undefined && rawAnchor !== null && typeof rawAnchor !== 'string') {
    throw new WebScanScheduleError(
      'invalid_anchor_date',
      'The anchor date must be written as YYYY-MM-DD.',
      'anchorDate',
    );
  }
  const anchorDate = rawAnchor === undefined || rawAnchor === null ? undefined : rawAnchor;

  const savedAt = options.savedAt ?? new Date();

  if (frequency === 'weekly' && weekday === undefined) {
    throw new WebScanScheduleError(
      'missing_weekday',
      'The weekly frequency needs a weekday.',
      'weekday',
    );
  }

  if (frequency === 'monthly' && dayOfMonth === undefined) {
    throw new WebScanScheduleError(
      'missing_day_of_month',
      'The monthly frequency needs a day of the month.',
      'dayOfMonth',
    );
  }

  if (frequency === 'biweekly') {
    const anchor = resolveBiweeklyAnchor(anchorDate, weekday, savedAt);
    const rule: WebScanSchedule = {
      frequency,
      hour,
      minute,
      enabled: enabled ?? false,
      weekday: anchor.weekday,
      anchorDate: formatKuDate(anchor.date),
    };
    return rule;
  }

  const rule: WebScanSchedule = { frequency, hour, minute, enabled: enabled ?? false };
  if (weekday !== undefined) rule.weekday = weekday;
  if (dayOfMonth !== undefined) rule.dayOfMonth = dayOfMonth;
  if (anchorDate !== undefined) rule.anchorDate = anchorDate;
  return rule;
}

/**
 * The anchor of a biweekly schedule and the weekday it fixes.
 *
 * A named anchor date must agree with a named weekday; without an anchor the first
 * matching weekday on or after the save time is used, so a biweekly rule always lands
 * on the weekday the administrator asked for.
 */
function resolveBiweeklyAnchor(
  anchorDate: string | undefined,
  weekday: number | undefined,
  savedAt: Date,
): { date: KuDate; weekday: number } {
  if (anchorDate !== undefined) {
    const parsed = parseKuwaitLocalDate(anchorDate);
    if (parsed === null) {
      throw new WebScanScheduleError(
        'invalid_anchor_date',
        'The anchor date must be a calendar date written as YYYY-MM-DD.',
        'anchorDate',
      );
    }
    const anchorWeekday = weekdayOf(parsed);
    if (weekday !== undefined && anchorWeekday !== normalizeWeekday(weekday)) {
      throw new WebScanScheduleError(
        'weekday_anchor_mismatch',
        'The anchor date does not fall on the requested weekday.',
        'anchorDate',
      );
    }
    return { date: parsed, weekday: anchorWeekday };
  }

  if (weekday === undefined) {
    const today = toKuwait(savedAt);
    const date: KuDate = { year: today.year, month: today.month, day: today.day };
    return { date, weekday: today.weekday };
  }

  const today = toKuwait(savedAt);
  const delta = (normalizeWeekday(weekday) - today.weekday + 7) % 7;
  const date = addDays({ year: today.year, month: today.month, day: today.day }, delta);
  return { date, weekday: normalizeWeekday(weekday) };
}
