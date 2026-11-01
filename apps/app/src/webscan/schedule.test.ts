import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_SCAN_SCHEDULE,
  KUWAIT_UTC_OFFSET_MINUTES,
  frequencyIntervalDays,
  kuwaitLocalDate,
  nextScheduledRun,
  parseSchedule,
  scheduledSlot,
  WebScanScheduleError,
} from './schedule.js';
import type { WebScanSchedule } from './types.js';

/**
 * The schedule arithmetic of the scanner (ADR-0052 section 5).
 *
 * Every expectation is written in UTC and compared against the Kuwait wall clock, so a
 * test fails if the rule starts to use the time zone of the host.
 */

/** 2026-01-01 is a Thursday. */
const THURSDAY_0300_KUWAIT = new Date('2026-01-01T00:00:00.000Z');

function schedule(overrides: Partial<WebScanSchedule>): WebScanSchedule {
  return {
    frequency: 'weekly',
    weekday: 5,
    hour: 4,
    minute: 0,
    enabled: true,
    ...overrides,
  };
}

describe('the Kuwait time of a schedule', () => {
  it('reads an instant on the Kuwait wall clock', () => {
    expect(KUWAIT_UTC_OFFSET_MINUTES).toBe(180);
    // 2026-01-01T00:00:00Z is 03:00 in Kuwait.
    expect(kuwaitLocalDate(THURSDAY_0300_KUWAIT)).toBe('2026-01-01');
    expect(scheduledSlot(schedule({}), THURSDAY_0300_KUWAIT).toISOString()).toBe(
      '2026-01-01T01:00:00.000Z',
    );
  });

  it('does not depend on the time zone of the host', () => {
    const previous = process.env['TZ'];
    try {
      process.env['TZ'] = 'America/New_York';
      expect(nextScheduledRun(schedule({}), THURSDAY_0300_KUWAIT).toISOString()).toBe(
        '2026-01-02T01:00:00.000Z',
      );
    } finally {
      if (previous === undefined) delete process.env['TZ'];
      else process.env['TZ'] = previous;
    }
  });
});

describe('the next occurrence of a schedule', () => {
  it('takes the next matching weekday of a weekly schedule', () => {
    // Thursday 03:00 Kuwait -> Friday 04:00 Kuwait.
    expect(nextScheduledRun(schedule({}), THURSDAY_0300_KUWAIT).toISOString()).toBe(
      '2026-01-02T01:00:00.000Z',
    );
  });

  it('is always strictly after the moment it is computed from', () => {
    const fridayAtSlot = new Date('2026-01-02T01:00:00.000Z');
    expect(nextScheduledRun(schedule({}), fridayAtSlot).toISOString()).toBe(
      '2026-01-09T01:00:00.000Z',
    );
  });

  it('takes today of a daily schedule when the slot is still ahead', () => {
    expect(
      nextScheduledRun(schedule({ frequency: 'daily' }), THURSDAY_0300_KUWAIT).toISOString(),
    ).toBe('2026-01-01T01:00:00.000Z');
  });

  it('takes tomorrow of a daily schedule when the slot has passed', () => {
    const afterSlot = new Date('2026-01-01T02:00:00.000Z');
    expect(
      nextScheduledRun(schedule({ frequency: 'daily' }), afterSlot).toISOString(),
    ).toBe('2026-01-02T01:00:00.000Z');
  });

  it('takes every 14 days of a biweekly schedule from its anchor', () => {
    const biweekly = schedule({ frequency: 'biweekly', anchorDate: '2026-01-02' });
    expect(nextScheduledRun(biweekly, THURSDAY_0300_KUWAIT).toISOString()).toBe(
      '2026-01-02T01:00:00.000Z',
    );
    expect(nextScheduledRun(biweekly, new Date('2026-01-03T00:00:00.000Z')).toISOString()).toBe(
      '2026-01-16T01:00:00.000Z',
    );
    expect(nextScheduledRun(biweekly, new Date('2026-02-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-02-13T01:00:00.000Z',
    );
  });

  it('clamps the day of a monthly schedule to the last day of the month', () => {
    const monthly = schedule({ frequency: 'monthly', dayOfMonth: 31 });
    expect(nextScheduledRun(monthly, new Date('2026-01-15T00:00:00.000Z')).toISOString()).toBe(
      '2026-01-31T01:00:00.000Z',
    );
    // February 2026 has 28 days.
    expect(nextScheduledRun(monthly, new Date('2026-01-31T02:00:00.000Z')).toISOString()).toBe(
      '2026-02-28T01:00:00.000Z',
    );
    // March has 31 days again.
    expect(nextScheduledRun(monthly, new Date('2026-02-28T02:00:00.000Z')).toISOString()).toBe(
      '2026-03-31T01:00:00.000Z',
    );
  });
});

describe('the catch-up of a missed occurrence', () => {
  it('advances to the first future occurrence instead of replaying every interval', () => {
    const daily = schedule({ frequency: 'daily' });
    // The site missed five days. The one due occurrence is claimed and the schedule
    // moves to the first future occurrence, not to the next missed one.
    const now = new Date('2026-01-06T05:00:00.000Z');
    const due = new Date('2026-01-01T01:00:00.000Z');
    expect(due.getTime()).toBeLessThan(now.getTime());
    expect(nextScheduledRun(daily, now).toISOString()).toBe('2026-01-07T01:00:00.000Z');
  });
});

describe('the validation of a schedule', () => {
  it('rejects an unknown frequency', () => {
    expect(() => parseSchedule({ frequency: 'hourly', hour: 4, minute: 0 })).toThrow(
      WebScanScheduleError,
    );
  });

  it('rejects an hour or a minute out of range', () => {
    expect(() => parseSchedule({ frequency: 'daily', hour: 24, minute: 0 })).toThrow(
      WebScanScheduleError,
    );
    expect(() => parseSchedule({ frequency: 'daily', hour: 4, minute: 60 })).toThrow(
      WebScanScheduleError,
    );
    expect(() => parseSchedule({ frequency: 'daily', hour: 1.5, minute: 0 })).toThrow(
      WebScanScheduleError,
    );
  });

  it('asks the weekly frequency for a weekday', () => {
    expect(() => parseSchedule({ frequency: 'weekly', hour: 4, minute: 0 })).toThrow(
      WebScanScheduleError,
    );
    expect(parseSchedule({ frequency: 'weekly', weekday: 0, hour: 4, minute: 0 }).weekday).toBe(0);
  });

  it('asks the monthly frequency for a day of the month between 1 and 31', () => {
    expect(() => parseSchedule({ frequency: 'monthly', hour: 4, minute: 0 })).toThrow(
      WebScanScheduleError,
    );
    expect(() =>
      parseSchedule({ frequency: 'monthly', dayOfMonth: 32, hour: 4, minute: 0 }),
    ).toThrow(WebScanScheduleError);
    expect(
      parseSchedule({ frequency: 'monthly', dayOfMonth: 31, hour: 4, minute: 0 }).dayOfMonth,
    ).toBe(31);
  });

  it('rejects a biweekly anchor that is not a calendar date', () => {
    expect(() =>
      parseSchedule({ frequency: 'biweekly', weekday: 5, anchorDate: '2026-02-30', hour: 4, minute: 0 }),
    ).toThrow(WebScanScheduleError);
    expect(() =>
      parseSchedule({ frequency: 'biweekly', weekday: 5, anchorDate: '02-01-2026', hour: 4, minute: 0 }),
    ).toThrow(WebScanScheduleError);
  });

  it('rejects a biweekly anchor that does not fall on the requested weekday', () => {
    // 2026-01-01 is a Thursday, not a Friday.
    expect(() =>
      parseSchedule({
        frequency: 'biweekly',
        weekday: 5,
        anchorDate: '2026-01-01',
        hour: 4,
        minute: 0,
      }),
    ).toThrow(WebScanScheduleError);
  });

  it('anchors a biweekly schedule without an anchor on the requested weekday', () => {
    const parsed = parseSchedule(
      { frequency: 'biweekly', weekday: 5, hour: 4, minute: 0 },
      { savedAt: THURSDAY_0300_KUWAIT },
    );
    expect(parsed.anchorDate).toBe('2026-01-02');
    expect(parsed.weekday).toBe(5);
  });

  it('switches a new site off on the weekly Friday schedule at 04:00', () => {
    expect(DEFAULT_WEB_SCAN_SCHEDULE.frequency).toBe('weekly');
    expect(DEFAULT_WEB_SCAN_SCHEDULE.weekday).toBe(5);
    expect(DEFAULT_WEB_SCAN_SCHEDULE.hour).toBe(4);
    expect(DEFAULT_WEB_SCAN_SCHEDULE.minute).toBe(0);
    expect(DEFAULT_WEB_SCAN_SCHEDULE.enabled).toBe(false);
  });
});

describe('the interval of a frequency', () => {
  it('knows the span of every frequency', () => {
    expect(frequencyIntervalDays('daily')).toBe(1);
    expect(frequencyIntervalDays('weekly')).toBe(7);
    expect(frequencyIntervalDays('biweekly')).toBe(14);
    expect(frequencyIntervalDays('monthly')).toBe(30);
  });
});
