import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { SitesPanel } from './SitesPanel.js';
import {
  installFetch,
  jsonResponse,
  settingsFixture,
  siteFixture,
  siteWithScheduleFixture,
  sitesPageFixture,
} from './webscan-test-utils.js';

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
    expect(screen.getByRole('status')).toBeTruthy();
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
    expect(screen.getByRole('alert')).toBeTruthy();
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

  it('edits the site that was opened last, not the one that was open before', async () => {
    const calls = installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
      if (call.method === 'PATCH') return jsonResponse(siteWithScheduleFixture);
      if (call.method === 'GET') return jsonResponse(sitesPageFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Edit: example.com' }));
    expect((screen.getByLabelText('Hostname') as HTMLInputElement).value).toBe('example.com');

    // The second edit opens while the form of the first site is still open.
    await user.click(screen.getByRole('button', { name: 'Edit: scheduled.example.com' }));
    expect((screen.getByLabelText('Hostname') as HTMLInputElement).value).toBe('scheduled.example.com');

    // The schedule of the second site is the one that is saved.
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '5' } });
    await user.click(screen.getByLabelText('I own this site or have explicit permission to test it'));
    await user.click(screen.getByRole('button', { name: 'Save the site' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toBe(`/api/admin/web-scan/sites/${siteWithScheduleFixture.id}`);
    expect(patch?.body).toEqual({
      schedule: { frequency: 'daily', hour: 5, minute: 30, enabled: true },
      authorize: true,
    });
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

  it('shows the rule the site inherits and lets the administrator switch it off', async () => {
    const calls = installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) {
        return jsonResponse({
          ...settingsFixture,
          defaultSchedule: { ...settingsFixture.defaultSchedule, enabled: true },
        });
      }
      if (call.method === 'PATCH') return jsonResponse(siteFixture);
      if (call.method === 'GET') return jsonResponse(sitesPageFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Edit: example.com' }));
    const form = screen.getByRole('form', { name: 'Edit the site' });
    const schedule = within(form).getByRole('group', { name: 'Schedule' });
    // The rule the site inherits is in force, so the switch is on.
    const toggle = within(schedule).getByRole('switch', { name: 'The schedule is on' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // Switching it off gives the site a rule of its own that is off.
    await user.click(toggle);
    await user.click(
      within(form).getByLabelText('I own this site or have explicit permission to test it'),
    );
    await user.click(within(form).getByRole('button', { name: 'Save the site' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH');
    const body = patch?.body as { schedule?: { enabled?: boolean } };
    expect(body.schedule?.enabled).toBe(false);
  });

  it('sends no rule when the administrator does not touch the inherited one', async () => {
    const calls = installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) {
        return jsonResponse({
          ...settingsFixture,
          defaultSchedule: { ...settingsFixture.defaultSchedule, enabled: true },
        });
      }
      if (call.method === 'GET') return jsonResponse(sitesPageFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Edit: example.com' }));
    await user.click(screen.getByRole('button', { name: 'Save the site' }));

    // Nothing changed, so no request carries a rule at all.
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit the site' })).toBeNull());
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches).toHaveLength(0);
  });

  it('removes the row of the middle of a list and keeps the values of the other rows', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Add site' }));
    const crawlPaths = within(screen.getByRole('group', { name: 'Crawl paths' }));
    for (const path of ['/a', '/b', '/c']) {
      await user.click(crawlPaths.getByRole('button', { name: 'Add' }));
      const inputs = crawlPaths.getAllByLabelText('Crawl paths');
      await user.type(inputs[inputs.length - 1]!, path);
    }
    const values = () =>
      crawlPaths.getAllByLabelText('Crawl paths').map((input) => (input as HTMLInputElement).value);
    expect(values()).toEqual(['/a', '/b', '/c']);

    const middle = crawlPaths.getAllByLabelText('Crawl paths')[1]!;
    await user.click(crawlPaths.getByRole('button', { name: 'Remove: /b' }));

    // The row of the middle is gone with its own input.
    expect(document.body.contains(middle)).toBe(false);
    // The other rows keep their own values.
    expect(values()).toEqual(['/a', '/c']);
  });

  it('goes back to the first page when the last site of the last page is removed', async () => {
    let all = Array.from({ length: 26 }, (_, index) => ({
      ...siteFixture,
      id: `site-${index + 1}`,
      hostname: `site-${index + 1}.example.com`,
    }));
    const calls = installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
      if (call.method === 'DELETE') {
        all = all.slice(0, -1);
        return jsonResponse(siteFixture);
      }
      if (call.method === 'GET') {
        const offset = Number(new URL(call.url, 'http://local').searchParams.get('offset') ?? 0);
        return jsonResponse({
          sites: all.slice(offset, offset + 25),
          total: all.length,
          limit: 25,
          offset,
        });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await screen.findByText('site-1.example.com');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('site-26.example.com')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove: site-26.example.com' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    // The page that is empty is left behind: the list goes back to the first page.
    await waitFor(() => expect(screen.getByText('site-1.example.com')).toBeTruthy());
    const siteCalls = calls.filter((call) => call.method === 'GET' && call.url.includes('/sites?'));
    expect(siteCalls[siteCalls.length - 1]?.url).toContain('offset=0');
    expect(screen.queryByText('site-26.example.com')).toBeNull();
  });

  it('shows the error state when the global policy cannot be read', async () => {
    installFetch((call) =>
      call.url.startsWith('/api/admin/web-scan/settings')
        ? jsonResponse({ error: { code: 'broken', message: 'boom' } }, 500)
        : jsonResponse(sitesPageFixture),
    );
    renderWithProviders(<SitesPanel />);

    // The policy decides the rule every site inherits, so the list waits for
    // it instead of showing rules that do not exist.
    expect(await screen.findByText('Could not load the data. Please try again.')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('example.com')).toBeNull();
  });

  it('shows the permission-lost state when the save of the site is refused', async () => {
    installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
      if (call.method === 'PATCH') {
        return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
      }
      if (call.method === 'GET') return jsonResponse(sitesPageFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Edit: example.com' }));
    const form = screen.getByRole('form', { name: 'Edit the site' });
    fireEvent.change(within(form).getByLabelText('Hour'), { target: { value: '5' } });
    await user.click(
      within(form).getByLabelText('I own this site or have explicit permission to test it'),
    );
    await user.click(within(form).getByRole('button', { name: 'Save the site' }));

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
  });

  it('keeps the dialog of the removal open when the removal fails', async () => {
    installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
      if (call.method === 'DELETE') {
        return jsonResponse({ error: { code: 'broken', message: 'boom' } }, 500);
      }
      if (call.method === 'GET') return jsonResponse(sitesPageFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Remove: example.com' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    // The site is still there: the dialog stays open and says what happened.
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes the dialog of the removal and asks for the list again', async () => {
    const calls = installFetch((call) => {
      if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
      if (call.method === 'DELETE') return jsonResponse(siteFixture);
      if (call.method === 'GET') return jsonResponse(sitesPageFixture);
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<SitesPanel />);

    await user.click(await screen.findByRole('button', { name: 'Remove: example.com' }));
    const dialog = await screen.findByRole('dialog');
    const before = calls.filter((call) => call.method === 'GET' && call.url.includes('/sites?')).length;
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url.includes('/sites?')).length,
      ).toBeGreaterThan(before),
    );
  });
});
