/**
 * The Kuwait wall clock (ADR-0052 section 5).
 *
 * Every occurrence of a scan is computed in Kuwait time (`Asia/Kuwait`, UTC+3, no
 * daylight saving), so the rule does not depend on the time zone of the process that
 * evaluates it.
 *
 * The helpers read an instant with the UTC getters after shifting it by the fixed
 * Kuwait offset, and they do their calendar arithmetic on UTC midnight, which never
 * observes daylight saving either.
 */

/** The time zone every schedule is written in. */
export const KUWAIT_TIME_ZONE = 'Asia/Kuwait';

/** Kuwait is a fixed UTC+3 offset and never observes daylight saving. */
export const KUWAIT_UTC_OFFSET_MINUTES = 180;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A calendar date without a time of day. */
export interface KuDate {
  readonly year: number;
  /** 0 is January. */
  readonly month: number;
  readonly day: number;
}

/** A calendar date with its weekday. 0 is Sunday. */
export interface KuDateWithWeekday extends KuDate {
  readonly weekday: number;
}

/** A moment read on the Kuwait wall clock. */
export interface KuMoment extends KuDateWithWeekday {
  readonly hour: number;
  readonly minute: number;
}

/**
 * The Kuwait wall-clock reading of an instant.
 *
 * The instant is shifted by the fixed Kuwait offset and then read with the UTC
 * getters, so the reading never depends on the time zone of the host.
 */
export function toKuwait(date: Date): KuMoment {
  const shifted = new Date(date.getTime() + KUWAIT_UTC_OFFSET_MINUTES * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** The instant of a Kuwait wall-clock reading. */
export function kuwaitInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month, day);
  utc.setUTCHours(hour, minute, 0, 0);
  return new Date(utc.getTime() - KUWAIT_UTC_OFFSET_MINUTES * MINUTE_MS);
}

/** Midnight UTC of a calendar date, used for the calendar arithmetic only. */
function utcMidnight(year: number, month: number, day: number): number {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month, day);
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getTime();
}

/** The number of days in a month. */
export function daysInMonth(year: number, month: number): number {
  const utc = new Date(0);
  utc.setUTCFullYear(year, month + 1, 0);
  utc.setUTCHours(0, 0, 0, 0);
  return utc.getUTCDate();
}

/** The weekday of a calendar date. 0 is Sunday. */
export function weekdayOf(date: KuDate): number {
  return new Date(utcMidnight(date.year, date.month, date.day)).getUTCDay();
}

/**
 * The calendar date `days` days after `date`.
 *
 * The arithmetic runs on UTC midnight, which has no daylight saving, so a day is
 * always exactly 24 hours and a month rollover is handled by the date itself.
 */
export function addDays(date: KuDate, days: number): KuDate {
  const shifted = new Date(utcMidnight(date.year, date.month, date.day) + days * DAY_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/** Writes a calendar date as `YYYY-MM-DD`. */
export function formatKuDate(date: KuDate): string {
  const month = String(date.month + 1).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${month}-${day}`;
}

/** The local date of an instant, written as `YYYY-MM-DD`. */
export function kuwaitLocalDate(date: Date): string {
  const k = toKuwait(date);
  return formatKuDate({ year: k.year, month: k.month, day: k.day });
}

/** Parses a `YYYY-MM-DD` calendar date. Returns null when the text is not one. */
export function parseKuwaitLocalDate(value: string): KuDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 0 || month > 11) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}
