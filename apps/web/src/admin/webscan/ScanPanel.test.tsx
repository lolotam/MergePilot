import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { ScanPanel } from './ScanPanel.js';
import { WebScanSelectionProvider } from './selection.js';
import {
  FakeEventSource,
  exceptionsPageFixture,
  installFetch,
  jsonResponse,
  scanDetailFixture,
  scanFixture,
  scansPageFixture,
  siteFixture,
  sitesPageFixture,
  type RecordedCall,
} from './webscan-test-utils.js';

const originalFetch = global.fetch;
const originalEventSource = global.EventSource;

beforeEach(() => {
  FakeEventSource.instances = [];
  global.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  global.fetch = originalFetch;
  global.EventSource = originalEventSource;
});

/** The answers of the area, by the path of the call. */
function answerWithFixtures(call: RecordedCall): Response {
  const path = call.url.split('?')[0] ?? '';
  if (call.method === 'POST' && path.endsWith('/scans')) {
    return jsonResponse({ scan: scanFixture, replayed: false }, 201);
  }
  if (call.method === 'POST' && path.endsWith('/stop')) {
    return jsonResponse({ scan: { ...scanFixture, status: 'stopped' } });
  }
  if (call.method === 'GET' && path.endsWith('/scans')) return jsonResponse(scansPageFixture);
  if (call.method === 'GET' && path.includes('/scans/')) return jsonResponse(scanDetailFixture);
  if (call.method === 'GET' && path.endsWith('/exceptions')) return jsonResponse(exceptionsPageFixture);
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

describe('the scan panel of the website scan', () => {
  it('starts a scan only with a fresh confirmation every time', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    const start = screen.getByRole('button', { name: 'Start a manual scan' });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    await user.click(start);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(start);
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));

    // The confirmation belongs to one start: the next one needs it again.
    const checkbox = screen.getByLabelText(CONFIRMATION) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    expect(calls.filter((call) => call.method === 'POST').length).toBe(1);
  });

  it('keeps the idempotency key of a request the server never accepted', async () => {
    let failed = false;
    const calls = installFetch((call) => {
      if (call.method === 'POST' && !failed && call.url.endsWith('/scans')) {
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

    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await waitFor(() =>
      expect(calls.filter((call) => call.method === 'POST').length).toBe(2),
    );

    const posts = calls.filter((call) => call.method === 'POST');
    const first = posts[0]?.body as { idempotencyKey: string };
    const second = posts[1]?.body as { idempotencyKey: string };
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });

  it('gives a new intent a new idempotency key', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').length).toBe(1));

    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').length).toBe(2));

    const posts = calls.filter((call) => call.method === 'POST');
    const first = posts[0]?.body as { idempotencyKey: string };
    const second = posts[1]?.body as { idempotencyKey: string };
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });

  it('shows the state of the scan and its live counters', async () => {
    installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));

    expect(await screen.findAllByText('Running')).toBeTruthy();
    const stream = FakeEventSource.instances[0];
    expect(stream).toBeTruthy();
    expect(stream?.url).toBe(`/api/admin/web-scan/scans/${scanFixture.id}/events`);
    expect(stream?.withCredentials).toBe(true);

    stream?.emit('scan', {
      scanId: scanFixture.id,
      siteId: siteFixture.id,
      kind: 'progress',
      status: 'running',
      requests: 42,
      pages: 9,
      elapsedMs: 12000,
    });

    await waitFor(() => expect(screen.getByText('42')).toBeTruthy());
    expect(screen.getByText('9')).toBeTruthy();
  });

  it('refetches the state of the scan when the stream reconnects', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await screen.findAllByText('Running');

    const before = calls.filter((call) => call.url.includes(`/scans/${scanFixture.id}`)).length;
    FakeEventSource.instances[0]?.open();

    await waitFor(() =>
      expect(calls.filter((call) => call.url.includes(`/scans/${scanFixture.id}`)).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('stops a running scan', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(screen.getByLabelText(CONFIRMATION));
    await user.click(screen.getByRole('button', { name: 'Start a manual scan' }));
    await screen.findAllByText('Running');

    await user.click(screen.getByRole('button', { name: 'Stop the scan' }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/stop'))).toBe(true),
    );
  });

  it('lists the history of the site with every state of a scan', async () => {
    installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'GET' && path.endsWith('/scans')) {
        return jsonResponse({
          scans: [
            { ...scanFixture, id: 's-1', status: 'queued' },
            { ...scanFixture, id: 's-2', status: 'running' },
            { ...scanFixture, id: 's-3', status: 'completed' },
            { ...scanFixture, id: 's-4', status: 'stopped' },
            { ...scanFixture, id: 's-5', status: 'failed' },
          ],
          limit: 20,
          offset: 0,
        });
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderScanPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);

    const history = await screen.findByRole('table');
    const states = within(history)
      .getAllByText(/Queued|Running|Completed|Stopped|Failed/)
      .map((node) => node.textContent);
    expect(states).toEqual(['Queued', 'Running', 'Completed', 'Stopped', 'Failed']);
  });

  it('shows the permission-lost state when the session lost its admin rights', async () => {
    installFetch(() => jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404));
    renderScanPanel();

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
  });
});
