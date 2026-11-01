import { describe, expect, it } from 'vitest';
import { nextScheduledRun, WebScanScheduleError } from './schedule.js';
import { fixture, registeredSite, unpause } from './store.fixtures.js';

/**
 * The persisted schedule of a site (ADR-0052 section 5).
 *
 * A schedule is written once and read back many times, so the saved rule has to be
 * evaluable without any further guesswork: the biweekly rule keeps its anchor, and the
 * monthly rule keeps its day of the month. The store is the boundary where a rule is
 * accepted, so it is also the boundary where a rule is normalized and where an invalid
 * rule is refused.
 */

describe('the schedule of a site', () => {
  it('keeps the anchor of a biweekly rule and evaluates it on read', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      const saved = await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'biweekly', weekday: 5, hour: 4, minute: 0, enabled: true },
      });

      // The rule was saved with the anchor it was normalized to.
      expect(saved.schedule?.frequency).toBe('biweekly');
      expect(saved.schedule?.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(saved.schedule?.weekday).toBe(5);

      // And the saved rule is evaluable: it does not throw and it lands on a Friday.
      const next = nextScheduledRun(saved.schedule!, new Date('2026-11-01T00:00:00.000Z'));
      expect(next.getTime()).toBeGreaterThan(new Date('2026-11-01T00:00:00.000Z').getTime());
      expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuwait', weekday: 'short' }).format(next)).toBe(
        'Fri',
      );

      // The rule survives a round trip through the database unchanged.
      const reread = await store.getSite(site.id);
      expect(reread?.schedule).toEqual(saved.schedule);
    } finally {
      await db.close();
    }
  });

  it('keeps a named anchor and refuses one that falls on another weekday', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      const saved = await store.updateSite('admin-1', site.id, {
        schedule: {
          frequency: 'biweekly',
          weekday: 5,
          hour: 4,
          minute: 0,
          enabled: true,
          anchorDate: '2026-01-02',
        },
      });
      expect(saved.schedule?.anchorDate).toBe('2026-01-02');

      await expect(
        store.updateSite('admin-1', site.id, {
          schedule: {
            frequency: 'biweekly',
            weekday: 3,
            hour: 4,
            minute: 0,
            enabled: true,
            anchorDate: '2026-01-02',
          },
        }),
      ).rejects.toBeInstanceOf(WebScanScheduleError);
    } finally {
      await db.close();
    }
  });

  it('keeps a monthly rule of the thirty first and refuses a day past the end of a month', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      const saved = await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'monthly', dayOfMonth: 31, hour: 4, minute: 0, enabled: true },
      });
      expect(saved.schedule?.dayOfMonth).toBe(31);

      await expect(
        store.updateSite('admin-1', site.id, {
          schedule: { frequency: 'monthly', dayOfMonth: 32, hour: 4, minute: 0, enabled: true },
        }),
      ).rejects.toBeInstanceOf(WebScanScheduleError);
    } finally {
      await db.close();
    }
  });

  it('refuses an invalid rule and keeps the saved one', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      const saved = await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'daily', hour: 4, minute: 0, enabled: true },
      });

      await expect(
        store.updateSite('admin-1', site.id, {
          schedule: { frequency: 'weekly', hour: 4, minute: 0, enabled: true },
        }),
      ).rejects.toBeInstanceOf(WebScanScheduleError);

      expect((await store.getSite(site.id))?.schedule).toEqual(saved.schedule);
    } finally {
      await db.close();
    }
  });

  it('normalizes the default schedule of the installation as well', async () => {
    const { db, store } = await fixture();
    try {
      const settings = await store.updateSettings('admin-1', {
        defaultSchedule: { frequency: 'biweekly', weekday: 2, hour: 4, minute: 0, enabled: true },
      });
      expect(settings.defaultSchedule.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(settings.defaultSchedule.weekday).toBe(2);
      expect(nextScheduledRun(settings.defaultSchedule, new Date('2026-11-01T00:00:00.000Z'))).toBeInstanceOf(
        Date,
      );
    } finally {
      await db.close();
    }
  });

  it('does not treat the same rule as a change of the schedule', async () => {
    const { db, store } = await fixture();
    try {
      const site = await registeredSite(store);
      const rule = { frequency: 'daily', hour: 4, minute: 0, enabled: true } as const;
      const first = await store.updateSite('admin-1', site.id, { schedule: rule });

      // The same rule again, with the keys in another order.
      const second = await store.updateSite('admin-1', site.id, {
        schedule: { enabled: true, minute: 0, hour: 4, frequency: 'daily' },
      });

      expect(second.authorization.scopeVersion).toBe(first.authorization.scopeVersion);
      expect(second.schedule).toEqual(first.schedule);
    } finally {
      await db.close();
    }
  });
});

describe('the scheduled enqueue', () => {
  it('queues the due slot once and advances the schedule beyond now', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await store.updateSite('admin-1', site.id, {
        schedule: { frequency: 'daily', hour: 4, minute: 0, enabled: true },
      });

      // The site has no slot yet: the first occurrence is in the future.
      const now = new Date('2026-11-02T05:00:00.000Z');
      const first = await store.enqueueScheduledScan('scheduler', {
        siteId: site.id,
        scheduledFor: new Date('2026-11-03T01:00:00.000Z'),
        now,
      });
      expect(first.trigger).toBe('scheduled');
      expect((await store.getSite(site.id))?.nextRunAt?.toISOString()).toBe('2026-11-03T01:00:00.000Z');
      expect(await store.listScans(site.id)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('refuses to queue for a site without an enabled schedule', async () => {
    const { db, store } = await fixture();
    try {
      await unpause(store);
      const site = await registeredSite(store);
      await expect(
        store.enqueueScheduledScan('scheduler', {
          siteId: site.id,
          scheduledFor: new Date('2026-11-02T04:00:00.000Z'),
        }),
      ).rejects.toThrow(/schedule/i);
    } finally {
      await db.close();
    }
  });
});
