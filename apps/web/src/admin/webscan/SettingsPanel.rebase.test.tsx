import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { WebScanSettingsDto } from '@mergepilot/app/contract';
import { renderWithProviders } from '../admin-test-utils.js';
import { SettingsPanel } from './SettingsPanel.js';
import { installFetch, jsonResponse, settingsFixture } from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** A stamp of the server that is newer than the one of the fixtures. */
const NEWER = '2026-11-02T00:00:00.000Z';

/** The stamp of an answer that was already on its way when the newer one arrived. */
const STALE = '2026-11-01T12:00:00.000Z';

/** The patch of the last request the panel sent. */
function lastPatch(
  calls: { method: string; body: unknown }[],
): { method: string; body: unknown } | undefined {
  return calls.filter((call) => call.method === 'PATCH').at(-1);
}

/** Refetches the policy, as the tab does when it regains the focus. */
async function refetch(): Promise<void> {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

describe('the draft of the global policy and the answers of the server', () => {
  it('follows the server when the schedule was put back to the rule it was', async () => {
    let server: WebScanSettingsDto = settingsFixture;
    const calls = installFetch(() => jsonResponse(server));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    // The administrator edits the hour of the rule and puts it back.
    const hour = await screen.findByLabelText('Hour');
    fireEvent.change(hour, { target: { value: '6' } });
    fireEvent.change(hour, { target: { value: '4' } });

    // Another administrator changes the rule of the server.
    server = {
      ...server,
      defaultSchedule: { ...server.defaultSchedule, hour: 9 },
      updatedAt: NEWER,
    };
    await refetch();

    // The rule of the server is in the form.
    await waitFor(() => {
      expect((screen.getByLabelText('Hour') as HTMLInputElement).value).toBe('9');
    });

    // A save of another field never sends the rule.
    fireEvent.change(screen.getByLabelText('Requests per scan'), { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(lastPatch(calls)?.body).toEqual({ limits: { maxRequests: 800 } });
    });
  });

  it('keeps a schedule the administrator really changed', async () => {
    let server: WebScanSettingsDto = settingsFixture;
    const calls = installFetch(() => jsonResponse(server));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const hour = await screen.findByLabelText('Hour');
    fireEvent.change(hour, { target: { value: '6' } });

    // Another administrator changes the rule of the server.
    server = {
      ...server,
      defaultSchedule: { ...server.defaultSchedule, hour: 9 },
      updatedAt: NEWER,
    };
    await refetch();

    // The edit of the administrator stays in the form.
    await waitFor(() => {
      expect((screen.getByLabelText('Hour') as HTMLInputElement).value).toBe('6');
    });

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(lastPatch(calls)?.body).toEqual({
        defaultSchedule: { frequency: 'weekly', weekday: 5, hour: 6, minute: 0, enabled: false },
      });
    });
  });

  it('ignores an answer of the server that is older than the baseline', async () => {
    let server: WebScanSettingsDto = settingsFixture;
    const calls = installFetch(() => jsonResponse(server));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });

    // Another administrator raises another limit.
    server = { ...server, limits: { ...server.limits, maxPages: 150 }, updatedAt: NEWER };
    await refetch();
    await waitFor(() => {
      expect((screen.getByLabelText('Crawled pages') as HTMLInputElement).value).toBe('150');
    });

    // A reply that was already on its way arrives late: it is older than the
    // baseline, so it never moves the draft nor the baseline back.
    server = {
      ...settingsFixture,
      approvedInstallations: [
        { adminUserId: 'u-other', installationId: 102, githubAccountId: 66 },
      ],
      updatedAt: STALE,
    };
    await refetch();
    // The late answer reached the panel.
    await waitFor(() => {
      expect(screen.getByText('u-other')).toBeTruthy();
    });

    // The limit of the other administrator stays in the form.
    expect((screen.getByLabelText('Crawled pages') as HTMLInputElement).value).toBe('150');

    // The save of the limit never takes the limit of the other administrator back.
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(lastPatch(calls)?.body).toEqual({ limits: { maxRequests: 800 } });
    });
  });

  it('keeps the pause of the server when the request of the switch fails', async () => {
    let server: WebScanSettingsDto = settingsFixture;
    let refusePause: (() => void) | undefined;
    const calls = installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(server);
      const body = call.body as { paused?: boolean } | undefined;
      if (body?.paused !== undefined) {
        // The request of the kill switch stays on its way until the test ends it.
        return new Promise<Response>((resolve) => {
          refusePause = () =>
            resolve(
              jsonResponse(
                { error: { code: 'invalid_request', message: 'The pause was refused' } },
                500,
              ),
            );
        });
      }
      return jsonResponse(server);
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.click(await screen.findByRole('switch', { name: 'Pause all scans' }));
    await waitFor(() => expect(refusePause).toBeDefined());

    // Another administrator pauses the scanner; this tab refetches.
    server = { ...server, paused: true, retentionDays: 60, updatedAt: NEWER };
    await refetch();
    await waitFor(() => {
      expect((screen.getByLabelText('Retention (days)') as HTMLInputElement).value).toBe('60');
    });

    // The request of the switch fails.
    refusePause?.();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The pause was refused');

    // The switch shows the value of the server and not the one of the click.
    expect(
      screen.getByRole('switch', { name: 'Pause all scans' }).getAttribute('aria-checked'),
    ).toBe('true');

    // A save of another field never sends the pause.
    fireEvent.change(screen.getByLabelText('Requests per scan'), { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(lastPatch(calls)?.body).toEqual({ limits: { maxRequests: 800 } });
    });
  });
});
