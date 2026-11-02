import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { SitesPanel } from './SitesPanel.js';
import { installFetch, jsonResponse, settingsFixture, sitesPageFixture } from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function answerWithFixtures() {
  return installFetch((call) => {
    if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
    if (call.method === 'GET') return jsonResponse(sitesPageFixture);
    return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
}

describe('the sites of the website scan', () => {
  it('lists the sites and where the schedule of each one comes from', async () => {
    answerWithFixtures();
    renderWithProviders(<SitesPanel />);

    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.getByText('scheduled.example.com')).toBeTruthy();
    expect(screen.getByText('Global default')).toBeTruthy();
    expect(screen.getByText('Set for this site')).toBeTruthy();
  });

  it('shows the loading state while the sites are on their way', async () => {
    installFetch(() => new Promise<Response>(() => {}));
    renderWithProviders(<SitesPanel />);

    expect(await screen.findByText('Loading...')).toBeTruthy();
  });

  it('shows the empty state when no site is registered', async () => {    installFetch((call) =>
      call.url.startsWith('/api/admin/web-scan/settings')
        ? jsonResponse(settingsFixture)
        : jsonResponse({ sites: [], total: 0, limit: 25, offset: 0 }),
    );
    renderWithProviders(<SitesPanel />);

    expect(await screen.findByText('No sites are registered yet.')).toBeTruthy();
  });

  it('shows the permission-lost state when the session lost its admin rights', async () => {
    installFetch(() => jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404));
    renderWithProviders(<SitesPanel />);

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
  });

  it('refuses a registration without the authorization confirmation', async () => {
    const calls = answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Add site' }));
    await user.type(screen.getByLabelText('Hostname'), 'new.example.com');
    await user.type(screen.getByLabelText('Base URL'), 'https://new.example.com');
    await user.click(screen.getByRole('button', { name: 'Save the site' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This confirmation is required before saving.');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('registers a site with an empty scope and the authorization', async () => {
    const calls = answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Add site' }));

    // The scope starts empty: no rule of any group is there yet.
    expect(screen.queryByLabelText('Crawl paths')).toBeNull();
    expect(screen.queryByLabelText('Blocked paths')).toBeNull();
    expect(screen.queryByLabelText('Parameterized paths')).toBeNull();
    expect(screen.queryByLabelText('Active paths')).toBeNull();
    expect(screen.queryByLabelText('Extra file paths')).toBeNull();

    await user.type(screen.getByLabelText('Hostname'), 'new.example.com');
    await user.type(screen.getByLabelText('Base URL'), 'https://new.example.com');
    await user.click(screen.getByLabelText('I own this site or have explicit permission to test it'));
    await user.click(screen.getByRole('button', { name: 'Save the site' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      hostname: 'new.example.com',
      baseUrl: 'https://new.example.com',
      scope: {
        crawlPaths: [],
        blockedPaths: [],
        parameterizedPaths: [],
        activePaths: [],
        extraFilePaths: [],
      },
      schedule: null,
      authorize: true,
    });
  });

  it('refuses a path that is not a relative path', async () => {
    const calls = answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Add site' }));
    await user.type(screen.getByLabelText('Hostname'), 'new.example.com');
    await user.type(screen.getByLabelText('Base URL'), 'https://new.example.com');
    await user.click(screen.getByLabelText('I own this site or have explicit permission to test it'));

    const crawlPaths = within(screen.getByRole('group', { name: 'Crawl paths' }));
    await user.click(crawlPaths.getByRole('button', { name: 'Add' }));
    await user.type(crawlPaths.getByLabelText('Crawl paths'), 'products');
    await user.click(screen.getByRole('button', { name: 'Save the site' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Every path must start with a slash.');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('shows the source of the schedule in the edit form', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Edit: example.com' }));
    const form = screen.getByRole('form', { name: 'Edit the site' });
    const schedule = within(form).getByRole('group', { name: 'Schedule' });
    expect(within(schedule).getByText('Global default')).toBeTruthy();

    await user.click(within(form).getByRole('button', { name: 'Cancel the edit' }));
    await user.click(screen.getByRole('button', { name: 'Edit: scheduled.example.com' }));
    const secondForm = screen.getByRole('form', { name: 'Edit the site' });
    const secondSchedule = within(secondForm).getByRole('group', { name: 'Schedule' });
    expect(within(secondSchedule).getByText('Set for this site')).toBeTruthy();
  });

  it('removes a site only after the confirmation', async () => {
    const calls = answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Remove: example.com' }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    const removal = calls.find((call) => call.method === 'DELETE');
    expect(removal?.url).toBe('/api/admin/web-scan/sites/11111111-1111-4111-8111-111111111111');
  });
});
