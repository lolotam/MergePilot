import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../admin-test-utils.js';
import { AuditPanel } from './AuditPanel.js';
import {
  auditPageFixture,
  installFetch,
  jsonResponse,
  siteFixture,
  type RecordedCall,
} from './webscan-test-utils.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

/** The answers of the area: the audit log of the platform admin. */
function answerWithFixtures(call: RecordedCall): Response {
  const path = call.url.split('?')[0] ?? '';
  if (call.method === 'GET' && path.endsWith('/audit')) {
    const offset = Number(new URL(call.url, 'http://local').searchParams.get('offset') ?? 0);
    if (offset > 0) return jsonResponse({ audit: [], total: 1, limit: 25, offset });
    return jsonResponse(auditPageFixture);
  }
  return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
}

describe('the audit log of the website scan', () => {
  it('shows the newest entry first with its actor, its action and its target', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(<AuditPanel />);

    expect(await screen.findByText('u-admin')).toBeTruthy();
    expect(screen.getByText('scan.started')).toBeTruthy();
    expect(screen.getByText(`site · ${siteFixture.id}`)).toBeTruthy();
  });

  it('pages through the log with the total the server counts', async () => {
    const calls = installFetch((call) => {
      const path = call.url.split('?')[0] ?? '';
      if (call.method === 'GET' && path.endsWith('/audit')) {
        const offset = Number(new URL(call.url, 'http://local').searchParams.get('offset') ?? 0);
        const entries = Array.from({ length: offset === 0 ? 25 : 2 }, (_, index) => ({
          ...auditPageFixture.audit[0]!,
          id: `entry-${offset}-${index}`,
        }));
        return jsonResponse({ audit: entries, total: 27, limit: 25, offset });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404);
    });
    const user = userEvent.setup();
    renderWithProviders(<AuditPanel />);

    const next = await screen.findByRole('button', { name: 'Next' });
    expect((next as HTMLButtonElement).disabled).toBe(false);
    await user.click(next);

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes('offset=25'))).toBe(true),
    );
    // The page reaches the total of 27, so there is nothing after it.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('offers no control that could change an entry', async () => {
    installFetch(answerWithFixtures);
    renderWithProviders(<AuditPanel />);

    await screen.findByText('scan.started');
    // The whole log fits one page, so the panel has no control at all.
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
