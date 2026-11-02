import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { FindingsPanel } from './FindingsPanel.js';
import {
  attachmentResponse,
  exceptionFixture,
  exceptionsPageFixture,
  installFetch,
  jsonResponse,
  occurrenceFixture,
  scanDetailFixture,
  scanFixture,
} from './webscan-test-utils.js';

const originalFetch = global.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  global.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

/** The answers of the area: the exceptions of the site and the export. */
function answerWithFixtures(call: { url: string; method: string }): Response {
  const path = call.url.split('?')[0] ?? '';
  if (call.url.includes('/export')) {
    return attachmentResponse(`webscan-report-${scanFixture.id}.html`);
  }
  if (path.endsWith('/exceptions')) return jsonResponse(exceptionsPageFixture);
  return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

describe('the findings of a scan', () => {
  it('groups the occurrences of one issue and shows its risk factors', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(
      <FindingsPanel
        exceptions={exceptionsPageFixture.exceptions}
        detail={{
          ...scanDetailFixture,
          occurrences: [
            occurrenceFixture,
            {
              ...occurrenceFixture,
              id: 'occurrence-2',
              occurrenceKey: 'e'.repeat(64),
              targetKey: 'target-2',
              safeLocation: 'https://example.com/pricing',
              validation: 'Likely',
              confidence: 'medium',
              comparison: 'Unchanged',
            },
          ],
        }}
      />,
    );

    expect(await screen.findByText('strict-transport-security')).toBeTruthy();
    // One group with two members: the subject is shown once.
    expect(screen.getAllByText('strict-transport-security')).toHaveLength(1);
    expect(screen.getByText('Confirmed')).toBeTruthy();
    expect(screen.getByText('Likely')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('https://example.com/')).toBeTruthy();
    expect(screen.getByText('https://example.com/pricing')).toBeTruthy();

    // The risk and its factors come from the ADR of the group.
    expect(screen.getByText(/Risk:/)).toBeTruthy();
    expect(screen.getByText(/Severity base: 8/)).toBeTruthy();
    expect(screen.getByText(/Confidence factor: 1/)).toBeTruthy();
    expect(screen.getByText(/Validation factor: 1/)).toBeTruthy();
    expect(screen.getByText(/Surface factor: 1.1/)).toBeTruthy();
    expect(screen.getByText(/Affected targets: 2/)).toBeTruthy();
    expect(screen.getByText('An internal prioritization aid, not a CVSS score.')).toBeTruthy();
  });

  it('never shows an unchecked occurrence like a fixed one', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(
      <FindingsPanel
        exceptions={exceptionsPageFixture.exceptions}
        detail={{
          ...scanDetailFixture,
          occurrences: [
            { ...occurrenceFixture, comparison: 'Fixed', issueKey: 'headers:fixed' },
            {
              ...occurrenceFixture,
              id: 'occurrence-2',
              occurrenceKey: 'f'.repeat(64),
              issueKey: 'headers:not-checked',
              comparison: 'Not checked',
            },
          ],
        }}
      />,
    );

    const fixed = await screen.findByText('Fixed');
    const notChecked = screen.getByText('Not checked');
    expect(fixed.className).toContain('green');
    expect(fixed.className).not.toContain('amber');
    expect(notChecked.className).toContain('amber');
    expect(notChecked.className).not.toContain('green');
  });

  it('shows the exception that covers an occurrence and its end date', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(
      <FindingsPanel
        exceptions={exceptionsPageFixture.exceptions}
        detail={{
          ...scanDetailFixture,
          occurrences: [
            {
              ...occurrenceFixture,
              exceptionId: exceptionFixture.id,
              comparison: 'Unchanged',
            },
          ],
        }}
      />,
    );

    expect(await screen.findByText('Excepted')).toBeTruthy();
    expect(screen.getByText(/The exception: Accepted/)).toBeTruthy();
  });

  it('shows the coverage of every check with its reason', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(
      <FindingsPanel
        exceptions={exceptionsPageFixture.exceptions}
        detail={{
          ...scanDetailFixture,
          coverage: [
            {
              targetKey: 'target-1',
              checkId: 'headers',
              checkVersion: 1,
              evaluatedIssueIds: ['missing-hsts'],
              outcome: 'checked',
              reason: null,
            },
            {
              targetKey: 'target-2',
              checkId: 'files',
              checkVersion: 1,
              evaluatedIssueIds: ['exposed-env'],
              outcome: 'not-visited',
              reason: 'redirect_out_of_scope',
            },
          ],
        }}
      />,
    );

    const coverage = await screen.findByText('Coverage');
    const block = coverage.closest('section');
    expect(block).toBeTruthy();
    expect(within(block as HTMLElement).getByText(/Checked: 1/)).toBeTruthy();
    expect(within(block as HTMLElement).getAllByText(/Error: 0/).length).toBe(2);
    expect(within(block as HTMLElement).getByText(/Not visited: 1/)).toBeTruthy();
    expect(within(block as HTMLElement).getByText(/redirect out of the scope/)).toBeTruthy();
  });

  it('downloads the report of the scan with the name of the server', async () => {
    const calls = installFetch(answerWithFixtures);
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });
    URL.createObjectURL = vi.fn(() => 'blob:report');
    URL.revokeObjectURL = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<FindingsPanel detail={scanDetailFixture} exceptions={exceptionsPageFixture.exceptions} />);

    await user.click(await screen.findByRole('button', { name: 'Download the HTML report' }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    const exportCall = calls.find((call) => call.url.includes('/export'));
    expect(exportCall?.url).toBe(`/api/admin/web-scan/scans/${scanFixture.id}/export?format=html`);
    expect(clicks[0]?.download).toBe(`webscan-report-${scanFixture.id}.html`);
  });

  it('shows the empty state when the scan has no finding', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(<FindingsPanel detail={{ ...scanDetailFixture, occurrences: [] }} exceptions={[]} />);

    expect(await screen.findByText('This scan has no finding.')).toBeTruthy();
  });
});
