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

  it('shows the server error when the refusal carries no confirmation', async () => {
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

    expect(await screen.findByText('Could not load the data. Please try again.')).toBeTruthy();
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
    const calls = installFetch((call) =>
      call.method === 'GET'
        ? jsonResponse(settingsFixture)
        : jsonResponse({ ...settingsFixture, paused: true }),
    );
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
