import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

/** The digest the server sends with the refusal of a value above its default. */
const SERVER_DIGEST = 'd41d8cd98f00b204e9800998ecf8427e'.padEnd(64, '0');

/** The global policy with a rule of every two weeks that has its anchor day. */
const BIWEEKLY_SETTINGS: WebScanSettingsDto = {
  ...settingsFixture,
  defaultSchedule: {
    frequency: 'biweekly',
    weekday: 3,
    hour: 4,
    minute: 0,
    enabled: true,
    anchorDate: '2026-01-05',
  },
};

describe('the global policy of the website scan', () => {
  it('shows the effective values, the defaults and the read-only approved installations', async () => {
    installFetch(() => jsonResponse(settingsFixture));
    renderWithProviders(<SettingsPanel />);

    expect(await screen.findByText('Requests per scan')).toBeTruthy();
    expect((screen.getByLabelText('Requests per scan') as HTMLInputElement).value).toBe('500');
    expect(screen.getByText('Default: 500 requests')).toBeTruthy();
    expect(screen.getByText('Between 1 and 2,000')).toBeTruthy();

    expect(screen.getByRole('switch', { name: 'Active indicators' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Security headers' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Hour') as HTMLInputElement).value).toBe('4');
    expect((screen.getByLabelText('Retention (days)') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Contact of the User-Agent') as HTMLInputElement).value).toBe(
      'security@example.com',
    );

    expect(screen.getByText('u-admin')).toBeTruthy();
    expect(screen.getByText('Read-only')).toBeTruthy();
  });

  it('saves only the fields that changed', async () => {
    const calls = installFetch((call) =>
      call.method === 'GET'
        ? jsonResponse(settingsFixture)
        : jsonResponse({
            ...settingsFixture,
            limits: { ...settingsFixture.limits, maxRequests: 800 },
          }),
    );
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ limits: { maxRequests: 800 } });
    });
  });

  it('sends the pause on its own when the kill switch is flipped', async () => {
    const calls = installFetch((call) =>
      call.method === 'GET' ? jsonResponse(settingsFixture) : jsonResponse({ ...settingsFixture, paused: true }),
    );
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.click(await screen.findByRole('switch', { name: 'Pause all scans' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.body).toEqual({ paused: true });
    });
  });

  it('asks for a second confirmation when a limit is above its default', async () => {
    let patches = 0;
    const calls = installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      patches += 1;
      if (patches === 1) {
        return jsonResponse(
          {
            error: {
              code: 'confirmation_required',
              message: 'A value above its default needs a confirmation bound to the submitted values',
              digest: SERVER_DIGEST,
              fieldsAboveDefault: ['maxRequests'],
              effectiveLimits: { ...settingsFixture.limits, maxRequests: 800 },
            },
          },
          422,
        );
      }
      return jsonResponse({
        ...settingsFixture,
        limits: { ...settingsFixture.limits, maxRequests: 800 },
      });
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Requests per scan: 800 requests (default 500 requests)'),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm the values' }));

    await waitFor(() => expect(patches).toBe(2));
    const confirmPatch = calls.filter((call) => call.method === 'PATCH')[1];
    expect(confirmPatch?.body).toEqual({
      limits: { maxRequests: 800 },
      limitConfirmation: { digest: SERVER_DIGEST },
    });
  });

  it('lists exactly the fields the server named as above their default', async () => {
    let patches = 0;
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      patches += 1;
      if (patches === 1) {
        return jsonResponse(
          {
            error: {
              code: 'confirmation_required',
              message: 'A value above its default needs a confirmation',
              digest: SERVER_DIGEST,
              fieldsAboveDefault: ['maxRequests'],
              effectiveLimits: { ...settingsFixture.limits, maxRequests: 800 },
            },
          },
          422,
        );
      }
      return jsonResponse(settingsFixture);
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const requests = await screen.findByLabelText('Requests per scan');
    fireEvent.change(requests, { target: { value: '800' } });
    const pages = screen.getByLabelText('Crawled pages');
    fireEvent.change(pages, { target: { value: '200' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Requests per scan: 800 requests (default 500 requests)'),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Crawled pages/)).toBeNull();
  });

  it('lists the limits the server sent and not the ones of the form', async () => {
    let patches = 0;
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      patches += 1;
      if (patches === 1) {
        return jsonResponse(
          {
            error: {
              code: 'confirmation_required',
              message: 'A value above its default needs a confirmation',
              digest: SERVER_DIGEST,
              fieldsAboveDefault: ['maxRequests', 'maxPages'],
              // The row of the server holds a limit of another administrator
              // that this form never saw.
              effectiveLimits: { ...settingsFixture.limits, maxRequests: 800, maxPages: 150 },
            },
          },
          422,
        );
      }
      return jsonResponse(settingsFixture);
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const requests = await screen.findByLabelText('Requests per scan');
    fireEvent.change(requests, { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Requests per scan: 800 requests (default 500 requests)'),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('Crawled pages: 150 pages (default 100 pages)'),
    ).toBeTruthy();
  });

  it('keeps the panel and its draft when the refusal carries no effective limits', async () => {
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse(
        {
          error: {
            code: 'confirmation_required',
            message: 'A value above its default',
            digest: SERVER_DIGEST,
            fieldsAboveDefault: ['maxRequests'],
          },
        },
        422,
      );
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The panel stays on the screen with the draft of the administrator.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The settings were not saved');
    expect((screen.getByLabelText('Requests per scan') as HTMLInputElement).value).toBe('800');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the panel and its draft when the refusal carries no confirmation', async () => {
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse(
        { error: { code: 'confirmation_required', message: 'A value above its default' } },
        422,
      );
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The settings were not saved');
    expect((screen.getByLabelText('Requests per scan') as HTMLInputElement).value).toBe('800');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks a limit that is above its default', async () => {
    installFetch(() => jsonResponse(settingsFixture));
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });

    expect(await screen.findByText('Above default')).toBeTruthy();
  });

  it('shows the safe message of the server when it refuses a value', async () => {
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse(
        { error: { code: 'invalid_request', message: 'maxRequests is above its ceiling' } },
        422,
      );
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '9999' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('maxRequests is above its ceiling');
  });

  it('keeps the anchor day of a rule of every two weeks when only its hour changes', async () => {
    const calls = installFetch(() => jsonResponse(BIWEEKLY_SETTINGS));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const hour = await screen.findByLabelText('Hour');
    fireEvent.change(hour, { target: { value: '6' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({
      defaultSchedule: {
        frequency: 'biweekly',
        weekday: 3,
        hour: 6,
        minute: 0,
        enabled: true,
        anchorDate: '2026-01-05',
      },
    });
  });

  it('leaves the anchor day out when the rule is no longer a rule of every two weeks', async () => {
    const calls = installFetch(() => jsonResponse(BIWEEKLY_SETTINGS));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.selectOptions(await screen.findByLabelText('Frequency'), 'weekly');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({
      defaultSchedule: { frequency: 'weekly', weekday: 3, hour: 4, minute: 0, enabled: true },
    });
  });

  it('shows the permission-lost state when the session lost its admin rights', async () => {
    const calls = installFetch(() =>
      jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404),
    );
    renderWithProviders(<SettingsPanel />);

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
    await waitFor(() => expect(calls.length).toBe(1));
  });

  it('shows the load error when the server refuses to answer', async () => {
    installFetch(() => jsonResponse({ error: { code: 'invalid_request', message: 'broken' } }, 500));
    renderWithProviders(<SettingsPanel />);

    expect(await screen.findByText('Could not load the data. Please try again.')).toBeTruthy();
  });

  it('keeps the unsaved edits of the other fields when the kill switch is flipped', async () => {
    // The server remembers the pause, like the real one.
    let paused = false;
    const calls = installFetch((call) => {
      if (call.method !== 'GET') paused = true;
      return jsonResponse({ ...settingsFixture, paused });
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });
    await user.click(screen.getByRole('switch', { name: 'Pause all scans' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    // The edit of the limit is still in the form.
    expect((screen.getByLabelText('Requests per scan') as HTMLInputElement).value).toBe('800');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches[patches.length - 1]?.body).toEqual({ limits: { maxRequests: 800 } });
    });
  });

  it('never reverses a change another administrator made when an unrelated field is saved', async () => {
    let paused = false;
    const calls = installFetch(() => jsonResponse({ ...settingsFixture, paused }));
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });

    // Another administrator pauses every scan; this tab refetches when it regains the focus.
    paused = true;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: 'Pause all scans' });
      expect(toggle.getAttribute('aria-checked') === 'true' || (toggle as HTMLInputElement).checked).toBe(true);
    });
    // The edit of this administrator is still in the form.
    expect((screen.getByLabelText('Requests per scan') as HTMLInputElement).value).toBe('800');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The patch carries the limit and never takes the kill switch back.
    await waitFor(() => {
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches[patches.length - 1]?.body).toEqual({ limits: { maxRequests: 800 } });
    });
  });

  it('shows the permission-lost state when the save of the policy is refused', async () => {
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    const input = await screen.findByLabelText('Requests per scan');
    fireEvent.change(input, { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
  });

  it('shows the permission-lost state when the kill switch is refused', async () => {
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPanel />);

    await user.click(await screen.findByRole('switch', { name: 'Pause all scans' }));

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
  });
});
