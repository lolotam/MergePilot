import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { WebScanTab } from './WebScanTab.js';
import { installFetch, jsonResponse, settingsFixture, sitesPageFixture } from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function answerWithFixtures() {
  installFetch((call) => {
    if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
    if (call.url.startsWith('/api/admin/web-scan/sites')) return jsonResponse(sitesPageFixture);
    return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
}

describe('the website scan tab', () => {
  it('lists the five sections and opens the settings first', () => {
    answerWithFixtures();
    renderWithProviders(<WebScanTab />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Settings',
      'Sites',
      'Scans',
      'Exceptions',
      'Audit log',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('moves to the next section with the right arrow in English', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<WebScanTab />);

    screen.getByRole('tab', { name: 'Settings' }).focus();
    await user.keyboard('{ArrowRight}');

    const sites = screen.getByRole('tab', { name: 'Sites' });
    expect(sites.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sites);
  });

  it('moves to the next section with the left arrow in Arabic', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<WebScanTab />, { language: 'ar' });

    screen.getByRole('tab', { name: 'الإعدادات' }).focus();
    await user.keyboard('{ArrowLeft}');

    const sites = screen.getByRole('tab', { name: 'المواقع' });
    expect(sites.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(sites);
  });

  it('wraps around the sections', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<WebScanTab />);

    await user.click(screen.getByRole('tab', { name: 'Audit log' }));
    screen.getByRole('tab', { name: 'Audit log' }).focus();
    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows the empty state of the sections that are not here yet', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<WebScanTab />);

    await user.click(screen.getByRole('tab', { name: 'Scans' }));

    expect(screen.getByText('This section is not available yet.')).toBeTruthy();
    expect(screen.getByText('The scan results, the exceptions and the audit log are not part of this view.')).toBeTruthy();
  });
});
