import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { SettingsPanel } from './SettingsPanel.js';
import { installFetch, jsonResponse, settingsFixture } from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** The digest the server sends with the refusal of a value above its default. */
const SERVER_DIGEST = 'd41d8cd98f00b204e9800998ecf8427e'.padEnd(64, '0');

describe('the confirmation of a limit above its default', () => {
  it('keeps the form and its draft when the refusal carries no effective limits', async () => {
    installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse(
        {
          error: {
            code: 'confirmation_required',
            message: 'A value above its default needs a confirmation',
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

    // The panel is still there, with the draft of the administrator in it.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The settings were not saved');
    expect((screen.getByLabelText('Requests per scan') as HTMLInputElement).value).toBe('800');
    expect(screen.getByLabelText('Crawled pages')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms the values of the server even when they are outside the bounds of the dashboard', async () => {
    // The server is the authority of the limits it sends: the bounds the
    // dashboard knows are its own copy and never refuse its confirmation.
    const effective = { ...settingsFixture.limits, maxRequests: 999999 };
    const calls = installFetch((call) => {
      if (call.method === 'GET') return jsonResponse(settingsFixture);
      return jsonResponse(
        {
          error: {
            code: 'confirmation_required',
            message: 'A value above its default needs a confirmation',
            digest: SERVER_DIGEST,
            fieldsAboveDefault: ['maxRequests'],
            effectiveLimits: effective,
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

    // The dialog holds the values of the server, exactly as they were sent.
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Requests per scan: 999,999 requests (default 500 requests)'),
    ).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm the values' }));

    await waitFor(() => {
      const patches = calls.filter((call) => call.method === 'PATCH');
      expect(patches[patches.length - 1]?.body).toEqual({
        limits: { maxRequests: 800 },
        limitConfirmation: { digest: SERVER_DIGEST },
      });
    });
  });
});
