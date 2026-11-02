import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WebScanSettingsDto } from '@mergepilot/app/contract';
import { renderWithProviders } from '../admin-test-utils.js';
import { SettingsPanel } from './SettingsPanel.js';
import { installFetch, jsonResponse, settingsFixture } from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/**
 * The global policy with a rule of every two weeks that has its anchor day.
 *
 * The anchor falls on the Wednesday it names, as the server always writes it.
 */
const BIWEEKLY_SETTINGS: WebScanSettingsDto = {
  ...settingsFixture,
  defaultSchedule: {
    frequency: 'biweekly',
    weekday: 3,
    hour: 4,
    minute: 0,
    enabled: true,
    anchorDate: '2026-01-07',
  },
};

/** The patch of the last request the panel sent. */
function lastPatch(
  calls: { method: string; body: unknown }[],
): { method: string; body: unknown } | undefined {
  return calls.filter((call) => call.method === 'PATCH').at(-1);
}

describe('the rule of every two weeks and its anchor day', () => {
  it('sends the rule without its anchor when the weekday moved to another day', async () => {
    const calls = installFetch(() => jsonResponse(BIWEEKLY_SETTINGS));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.selectOptions(await screen.findByLabelText('Day of the week'), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The anchor of another day is refused by the server, so the rule travels
    // without it and the server anchors it on the day that was asked for.
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(lastPatch(calls)?.body).toEqual({
      defaultSchedule: { frequency: 'biweekly', weekday: 4, hour: 4, minute: 0, enabled: true },
    });
  });

  it('sends the anchor again when the weekday came back to the day of the anchor', async () => {
    const calls = installFetch(() => jsonResponse(BIWEEKLY_SETTINGS));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.selectOptions(await screen.findByLabelText('Day of the week'), '4');
    await user.selectOptions(screen.getByLabelText('Day of the week'), '3');
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '6' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(lastPatch(calls)?.body).toEqual({
      defaultSchedule: {
        frequency: 'biweekly',
        weekday: 3,
        hour: 6,
        minute: 0,
        enabled: true,
        anchorDate: '2026-01-07',
      },
    });
  });

  it('keeps the anchor of the rule while the frequency goes through another one', async () => {
    const calls = installFetch(() => jsonResponse(BIWEEKLY_SETTINGS));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.selectOptions(await screen.findByLabelText('Frequency'), 'weekly');
    await user.selectOptions(screen.getByLabelText('Frequency'), 'biweekly');
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '6' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The anchor belongs to the editing session: it is still the anchor of the
    // rule, so the rule keeps it.
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(lastPatch(calls)?.body).toEqual({
      defaultSchedule: {
        frequency: 'biweekly',
        weekday: 3,
        hour: 6,
        minute: 0,
        enabled: true,
        anchorDate: '2026-01-07',
      },
    });
  });
});
