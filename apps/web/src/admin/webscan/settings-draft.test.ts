import { describe, expect, it } from 'vitest';
import type { WebScanSettingsDto } from '@mergepilot/app/contract';
import { rebaseDraft, toSchedule, toScheduleDraft, toSettingsDraft } from './settings-draft.js';
import { settingsFixture } from './webscan-test-utils.js';

/** The anchor the server assigns when a rule becomes biweekly. */
const ANCHOR = '2026-11-06';

describe('the rebase of the settings draft onto a newer answer of the server', () => {
  it('adopts the server rule, with the anchor it assigned, once the edit was saved', () => {
    // The administrator turned the weekly rule into a biweekly one: no anchor yet.
    const baseline: WebScanSettingsDto = settingsFixture;
    const draft = toSettingsDraft(baseline);
    draft.defaultSchedule = toScheduleDraft({
      frequency: 'biweekly',
      weekday: 5,
      hour: 4,
      minute: 0,
      enabled: false,
    });

    // The server saved it and assigned the anchor of the first matching Friday.
    const server: WebScanSettingsDto = {
      ...baseline,
      defaultSchedule: { ...toSchedule(draft.defaultSchedule), anchorDate: ANCHOR },
      updatedAt: '2026-11-02T00:00:00.000Z',
    };

    const rebased = rebaseDraft(baseline, draft, server);

    // The next edit (only the hour) therefore still carries the anchor of the server.
    const next = toSchedule({ ...rebased.defaultSchedule, hour: 6 });
    expect(next).toMatchObject({ frequency: 'biweekly', hour: 6, anchorDate: ANCHOR });
  });

  it('keeps a local rule that the server does not have', () => {
    const baseline: WebScanSettingsDto = settingsFixture;
    const draft = toSettingsDraft(baseline);
    draft.defaultSchedule = toScheduleDraft({
      frequency: 'weekly',
      weekday: 2,
      hour: 9,
      minute: 30,
      enabled: true,
    });
    const server: WebScanSettingsDto = {
      ...baseline,
      defaultSchedule: { frequency: 'weekly', weekday: 5, hour: 7, minute: 0, enabled: false },
      updatedAt: '2026-11-02T00:00:00.000Z',
    };

    const rebased = rebaseDraft(baseline, draft, server);

    expect(toSchedule(rebased.defaultSchedule)).toMatchObject({ weekday: 2, hour: 9, minute: 30 });
  });

  it('follows the server for a rule the administrator never touched', () => {
    const baseline: WebScanSettingsDto = settingsFixture;
    const draft = toSettingsDraft(baseline);
    const server: WebScanSettingsDto = {
      ...baseline,
      defaultSchedule: { frequency: 'weekly', weekday: 3, hour: 1, minute: 0, enabled: true },
      updatedAt: '2026-11-02T00:00:00.000Z',
    };

    const rebased = rebaseDraft(baseline, draft, server);

    expect(toSchedule(rebased.defaultSchedule)).toMatchObject({ weekday: 3, hour: 1, enabled: true });
  });
});
