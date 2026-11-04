import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { ExceptionsPanel } from './ExceptionsPanel.js';
import { WebScanSelectionProvider } from './selection.js';
import {
  exceptionFixture,
  exceptionsPageFixture,
  installFetch,
  jsonResponse,
  occurrenceFixture,
  scanDetailFixture,
  siteFixture,
  siteWithScanFixture,
  sitesPageFixture,
  type RecordedCall,
} from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** The answers of the area, by the path of the call. */
function answerWithFixtures(call: RecordedCall): Response {
  const path = call.url.split('?')[0] ?? '';
  if (call.method === 'POST' && path.endsWith('/exceptions')) {
    return jsonResponse(exceptionFixture, 201);
  }
  if (call.method === 'DELETE' && path.includes('/exceptions/')) {
    return jsonResponse({ ...exceptionFixture, revokedAt: '2026-11-02T00:00:00.000Z' });
  }
  if (call.method === 'GET' && path.endsWith('/exceptions')) return jsonResponse(exceptionsPageFixture);
  if (call.method === 'GET' && path.includes('/scans/')) return jsonResponse(scanDetailFixture);
  if (call.method === 'GET' && path.endsWith('/sites')) {
    return jsonResponse({ ...sitesPageFixture, sites: [siteWithScanFixture], total: 1 });
  }
  return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

function renderExceptionsPanel() {
  return renderWithProviders(
    <WebScanSelectionProvider>
      <ExceptionsPanel />
    </WebScanSelectionProvider>,
  );
}

describe('the exceptions of the website scan', () => {
  it('lists the exceptions of the site with their end date and their state', async () => {
    installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);

    expect(await screen.findByText('Accepted')).toBeTruthy();
    expect(screen.getByText('Accepted risk')).toBeTruthy();
    expect(screen.getByText('The site is behind a gateway that owns the header.')).toBeTruthy();
    expect(screen.getByText('In force')).toBeTruthy();
  });

  it('gives the table of the exceptions an accessible name', async () => {
    installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);

    expect(await screen.findByRole('table', { name: 'Exceptions' })).toBeTruthy();
  });

  it('marks the mandatory fields as invalid until the administrator fixes them', async () => {
    installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: 'Add an exception' }));

    const form = screen.getByRole('form', { name: 'Add an exception' });
    const finding = within(form).getByLabelText('Finding');
    const reason = within(form).getByLabelText('Reason');

    expect(finding.getAttribute('aria-required')).toBe('true');
    expect(reason.getAttribute('aria-required')).toBe('true');
    expect(finding.hasAttribute('aria-invalid')).toBe(false);
    expect(reason.hasAttribute('aria-invalid')).toBe(false);
    expect(finding.getAttribute('aria-describedby')).not.toContain('-error');

    await user.click(within(form).getByRole('button', { name: 'Add an exception' }));

    expect(finding.getAttribute('aria-invalid')).toBe('true');
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(finding.getAttribute('aria-describedby')).toContain('-error');

    // The administrator fixed the reason: the error and the attribute are gone.
    await user.type(reason, 'The header is set by the CDN.');

    expect(reason.hasAttribute('aria-invalid')).toBe(false);
    expect(reason.getAttribute('aria-describedby')).not.toContain('-error');
    expect(within(form).queryByText('The reason is required.')).toBeNull();
  });

  it('adds an exception with its category, its reason and its end date', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: 'Add an exception' }));

    const form = screen.getByRole('form', { name: 'Add an exception' });
    await user.selectOptions(within(form).getByLabelText('Finding'), occurrenceFixture.occurrenceKey);
    await user.selectOptions(within(form).getByLabelText('Kind of the exception'), 'false_positive');
    await user.selectOptions(within(form).getByLabelText('Reason category'), 'third_party_dependency');
    await user.type(within(form).getByLabelText('Reason'), 'The header is set by the CDN.');
    await user.type(within(form).getByLabelText('End date'), '2026-12-24');
    await user.click(within(form).getByRole('button', { name: 'Add an exception' }));

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/exceptions'))).toBe(true),
    );
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      occurrenceKey: occurrenceFixture.occurrenceKey,
      evidenceHash: occurrenceFixture.evidenceHash,
      kind: 'false_positive',
      reasonCategory: 'third_party_dependency',
      reason: 'The header is set by the CDN.',
      expiresAt: '2026-12-24T23:59:59.999Z',
    });
  });

  it('refuses an exception without a reason', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: 'Add an exception' }));

    const form = screen.getByRole('form', { name: 'Add an exception' });
    await user.selectOptions(within(form).getByLabelText('Finding'), occurrenceFixture.occurrenceKey);
    await user.click(within(form).getByRole('button', { name: 'Add an exception' }));

    expect(await screen.findByText('The reason is required.')).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('revokes an exception only after the confirmation that restores the finding', async () => {
    const calls = installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: `Revoke: ${exceptionFixture.id}` }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'Revoking the exception brings the finding it covered back to the outstanding findings.',
      ),
    ).toBeTruthy();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    const removal = calls.find((call) => call.method === 'DELETE');
    expect(removal?.url).toBe(
      `/api/admin/web-scan/sites/${siteFixture.id}/exceptions/${exceptionFixture.id}`,
    );
  });

  it('shows the error state when the ledger of the site cannot be read', async () => {
    installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'GET' && path.includes('/scans/')) {
        return jsonResponse({ error: { code: 'broken', message: 'boom' } }, 500);
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);

    // The ledger is the list of the findings that can be resolved: a failed
    // request is not an empty ledger.
    expect(await screen.findByText('Could not load the data. Please try again.')).toBeTruthy();
  });

  it('keeps the dialog of the revocation open when the revocation fails', async () => {
    installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'DELETE' && path.includes('/exceptions/')) {
        return jsonResponse({ error: { code: 'broken', message: 'boom' } }, 500);
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: `Revoke: ${exceptionFixture.id}` }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    // The exception is still in force: the dialog stays open and says so.
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows the error state when the exceptions of the site cannot be read', async () => {
    installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'GET' && path.endsWith('/exceptions')) {
        return jsonResponse({ error: { code: 'broken', message: 'boom' } }, 500);
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);

    expect(await screen.findByText('Could not load the data. Please try again.')).toBeTruthy();
  });

  it('shows the permission-lost state when the revocation is refused', async () => {
    installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'DELETE' && path.includes('/exceptions/')) {
        return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
      }
      return answerWithFixtures(call);
    });
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: `Revoke: ${exceptionFixture.id}` }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    expect(
      await screen.findByText('Your platform admin rights are gone, so this area is not available.'),
    ).toBeTruthy();
  });

  it('closes the dialog of the revocation when the exception is revoked', async () => {
    installFetch(answerWithFixtures);
    const user = userEvent.setup();
    renderExceptionsPanel();

    await user.selectOptions(await screen.findByLabelText('Site'), siteFixture.id);
    await user.click(await screen.findByRole('button', { name: `Revoke: ${exceptionFixture.id}` }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
