import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { ScanPanel } from './ScanPanel.js';
import { WebScanSelectionProvider } from './selection.js';
import {
  installFetch,
  jsonResponse,
  scanFixture,
  scansPageFixture,
  siteFixture,
  siteWithScheduleFixture,
  sitesPageFixture,
  type RecordedCall,
} from './webscan-test-utils.js';

/**
 * The site the scan panel works on.
 *
 * The site is the target of the panel: the history of one site is never
 * shown under another one, and the confirmation and the idempotency key of
 * one site never start a scan of another one.
 */

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** The answers of the area, by the path of the call. */
function answerWithFixtures(call: RecordedCall): Response {
  const path = call.url.split('?')[0] ?? '';
  if (call.method === 'POST' && path.endsWith('/scans')) {
    return jsonResponse({ scan: scanFixture, replayed: false }, 201);
  }
  if (call.method === 'GET' && path.endsWith('/scans')) return jsonResponse(scansPageFixture);
  if (call.method === 'GET' && path.includes('/scans/')) {
    return jsonResponse({ scan: scanFixture, coverage: [], occurrences: [] });
  }
  if (call.method === 'GET' && path.endsWith('/sites')) return jsonResponse(sitesPageFixture);
  return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

function renderScanPanel() {
  return renderWithProviders(
    <WebScanSelectionProvider>
      <ScanPanel />
    </WebScanSelectionProvider>,
  );
}

const CONFIRMATION = 'I own this site or have explicit permission to test it';

describe('the site the scan panel works on', () => {
  it('never shows the history of the previous site while the new one loads', async () => {
    let releaseSecondSite: (() => void) | undefined;
    installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'GET' && path.endsWith('/scans')) {
        const siteId = call.url.split('/sites/')[1]?.split('/')[0] ?? '';
        if (siteId === siteFixture.id) {
          return jsonResponse({ ...scansPageFixture, scans: [{ ...scanFixture, id: 'scan-of-a' }] });
        }
        // The history of the second site is slow.
        return new Promise<Response>((resolve) => {
          releaseSecondSite = () =>
            resolve(
              jsonResponse({ ...scansPageFixture, scans: [{ ...scanFixture, id: 'scan-of-b' }] }),
            );
        });
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    expect(await screen.findByRole('button', { name: 'Open the scan: scan-of-a' })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Site'), siteWithScheduleFixture.id);

    // The rows of the other site are gone: the panel waits for the answer of
    // the site it shows now.
    expect(screen.queryByRole('button', { name: 'Open the scan: scan-of-a' })).toBeNull();
    expect(screen.getByText('Loading...')).toBeTruthy();

    releaseSecondSite?.();
    expect(await screen.findByRole('button', { name: 'Open the scan: scan-of-b' })).toBeTruthy();
  });

  it('drops the confirmation of the previous site when the site changes', async () => {
    installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    expect((screen.getByLabelText(CONFIRMATION) as HTMLInputElement).checked).toBe(true);

    // Another site is another target: the confirmation of the first one is
    // gone with it.
    await user.selectOptions(screen.getByLabelText('Site'), siteWithScheduleFixture.id);
    expect((screen.getByLabelText(CONFIRMATION) as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Start a manual scan' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('gives the start of another site a new idempotency key', async () => {
    let failed = false;
    const calls = installFetch((call) => {
      if (call.method === 'POST' && !failed) {
        failed = true;
        throw new TypeError('Failed to fetch');
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    // The key of the failed request belongs to the site it was sent for.
    await user.selectOptions(screen.getByLabelText('Site'), siteWithScheduleFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').length).toBe(2));

    const posts = calls.filter((call) => call.method === 'POST');
    const first = posts[0]?.body as { idempotencyKey: string };
    const second = posts[1]?.body as { idempotencyKey: string };
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('never opens the scan of a request that belongs to another site', async () => {
    let releaseEnqueue: (() => void) | undefined;
    const calls = installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'POST' && path.endsWith('/scans')) {
        return new Promise<Response>((resolve) => {
          releaseEnqueue = () =>
            resolve(
              jsonResponse({ scan: { ...scanFixture, id: 'scan-of-a' }, replayed: false }, 201),
            );
        });
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));

    // The site of a request that is on its way may not change.
    const select = screen.getByLabelText('Site') as HTMLSelectElement;
    expect(select.disabled).toBe(true);

    // The site changes anyway, and the answer of the other site comes late.
    fireEvent.change(select, { target: { value: siteWithScheduleFixture.id } });
    expect(select.value).toBe(siteWithScheduleFixture.id);
    await act(async () => {
      releaseEnqueue?.();
    });

    // The scan of the site the administrator left is never opened.
    expect(calls.some((call) => call.url.includes('/scans/scan-of-a'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Stop the scan' })).toBeNull();
  });
});
