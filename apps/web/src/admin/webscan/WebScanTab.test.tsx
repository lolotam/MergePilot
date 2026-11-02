import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { WebScanTab } from './WebScanTab.js';
import {
  auditPageFixture,
  exceptionsPageFixture,
  installFetch,
  jsonResponse,
  scanDetailFixture,
  scansPageFixture,
  settingsFixture,
  sitesPageFixture,
} from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function answerWithFixtures() {
  installFetch((call) => {
    const path = call.url.split('?')[0] ?? '';
    if (call.url.startsWith('/api/admin/web-scan/settings')) return jsonResponse(settingsFixture);
    if (path.endsWith('/sites')) return jsonResponse(sitesPageFixture);
    if (path.endsWith('/scans')) return jsonResponse(scansPageFixture);
    if (path.includes('/scans/')) return jsonResponse(scanDetailFixture);
    if (path.endsWith('/exceptions')) return jsonResponse(exceptionsPageFixture);
    if (path.endsWith('/audit')) return jsonResponse(auditPageFixture);
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

  it('shows the real panel of every section', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<WebScanTab />);

    await user.click(screen.getByRole('tab', { name: 'Scans' }));
    const picker = (await screen.findByLabelText('Site')) as HTMLSelectElement;
    expect(screen.getByText('Choose the site you want to scan.')).toBeTruthy();
    await user.selectOptions(picker, '11111111-1111-4111-8111-111111111111');
    expect(screen.getByRole('button', { name: 'Start a manual scan' })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Exceptions' }));
    expect(await screen.findByRole('button', { name: 'Add an exception' })).toBeTruthy();

    await user.click(screen.getByRole('tab', { name: 'Audit log' }));
    expect(await screen.findByText('scan.started')).toBeTruthy();
  });

  it('keeps the chosen site while the administrator moves between the sections', async () => {
    answerWithFixtures();
    const user = userEvent.setup();
    renderWithProviders(<WebScanTab />);

    await user.click(screen.getByRole('tab', { name: 'Scans' }));
    await user.selectOptions(await screen.findByLabelText('Site'), '11111111-1111-4111-8111-111111111111');

    await user.click(screen.getByRole('tab', { name: 'Exceptions' }));
    const picker = (await screen.findByLabelText('Site')) as HTMLSelectElement;
    expect(picker.value).toBe('11111111-1111-4111-8111-111111111111');
  });
});
