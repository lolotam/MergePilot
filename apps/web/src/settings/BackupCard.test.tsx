import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast.js';
import { BackupCard } from './BackupCard.js';
import { renderSettings } from './settings.fixtures.js';

/** An obvious fake passphrase built at runtime. */
const PASSPHRASE = ['web', 'backup', 'phrase', '42'].join('-');
const FILE = { format: 'mergepilot-settings', version: 1, settings: {}, bots: [], credentials: [] };
const PREVIEW = {
  dryRun: true,
  sections: ['settings', 'credentials'],
  settingsChanged: ['model', 'judge'],
  bots: 0,
  skills: 0,
  skillsMissing: [] as string[],
  credentials: [{ provider: 'anthropic', last4: 'q7q7', action: 'replace' }],
  keysTested: false,
};

type Call = { url: string; body: Record<string, unknown> };

describe('BackupCard (ADR-0018)', () => {
  const calls: Call[] = [];
  const originalFetch = global.fetch;
  let restoreAnswer: () => Response;

  beforeEach(() => {
    calls.length = 0;
    restoreAnswer = () => new Response(JSON.stringify(PREVIEW), { status: 200, headers: { 'content-type': 'application/json' } });
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith('/backup/export')) {
        return new Response(JSON.stringify(FILE), {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="mergepilot-settings-team-20261013.json"' },
        });
      }
      const answer = restoreAnswer();
      return body.dryRun === false ? new Response(JSON.stringify({ ...PREVIEW, dryRun: false }), { status: 200 }) : answer;
    }) as typeof fetch;
    URL.createObjectURL = vi.fn(() => 'blob:backup');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const renderCard = (role: 'owner' | 'admin' | 'member' = 'owner') =>
    renderSettings(
      <ToastProvider>
        <BackupCard workspaceId="ws-1" role={role} />
      </ToastProvider>,
      'en',
    );

  /** The file is read asynchronously: Preview enables once it is parsed. */
  const previewWhenReady = async (dialog: HTMLElement) => {
    const preview = within(dialog).getByRole('button', { name: 'Preview' }) as HTMLButtonElement;
    await waitFor(() => expect(preview.disabled).toBe(false));
    await userEvent.setup().click(preview);
  };

  it('is hidden for admins and members', () => {
    for (const role of ['admin', 'member'] as const) {
      const { unmount } = renderCard(role);
      expect(screen.queryByText('Backup & restore')).toBeNull();
      expect(screen.queryByRole('button', { name: /Download backup/ })).toBeNull();
      unmount();
    }
  });

  it('downloads a backup with the keys sealed by a confirmed passphrase', async () => {
    const user = userEvent.setup();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderCard();
    expect(screen.getByText(/without the passphrase the keys cannot be recovered/)).toBeDefined();
    expect((screen.getByLabelText('Include API keys (encrypted)') as HTMLInputElement).checked).toBe(true);
    const download = screen.getByRole('button', { name: 'Download backup' }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);

    await user.type(screen.getByLabelText('Passphrase'), PASSPHRASE);
    await user.type(screen.getByLabelText('Confirm passphrase'), PASSPHRASE);
    expect(download.disabled).toBe(false);
    await user.click(download);

    await waitFor(() => expect(screen.getByText('Backup downloaded')).toBeDefined());
    expect(calls).toEqual([{ url: '/api/workspaces/ws-1/backup/export', body: { includeKeys: true, passphrase: PASSPHRASE } }]);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect((clicked.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('mergepilot-settings-team-20261013.json');
    // The fields are cleared after the download.
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('');
  });

  it('blocks a short or mismatched passphrase; without keys no passphrase is needed', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderCard();
    const download = screen.getByRole('button', { name: 'Download backup' }) as HTMLButtonElement;

    await user.type(screen.getByLabelText('Passphrase'), 'short');
    expect(screen.getByText('The passphrase needs at least 12 characters.')).toBeDefined();
    await user.type(screen.getByLabelText('Passphrase'), '-but-long-now');
    await user.type(screen.getByLabelText('Confirm passphrase'), 'something else');
    expect(screen.getByRole('alert').textContent).toBe('The two passphrases do not match.');
    expect(download.disabled).toBe(true);

    await user.click(screen.getByLabelText('Include API keys (encrypted)'));
    expect(screen.queryByLabelText('Passphrase')).toBeNull();
    expect(download.disabled).toBe(false);
    await user.click(download);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ includeKeys: false });
  });

  it('previews the restore of the chosen sections, then restores after confirmation', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCard();
    await user.click(screen.getByRole('button', { name: /Restore from file/ }));
    const dialog = screen.getByRole('dialog');
    const restoreNow = within(dialog).getByRole('button', { name: 'Restore now' }) as HTMLButtonElement;
    expect(restoreNow.disabled).toBe(true);

    await user.upload(
      within(dialog).getByLabelText('Backup file'),
      new File([JSON.stringify(FILE)], 'backup.json', { type: 'application/json' }),
    );
    await user.type(within(dialog).getByLabelText(/File passphrase/), PASSPHRASE);
    await user.click(within(dialog).getByLabelText(/Reviewer bots/));
    await previewWhenReady(dialog);

    await waitFor(() => expect(within(dialog).getByText('What will change')).toBeDefined());
    expect(calls[0]).toEqual({
      url: '/api/workspaces/ws-1/backup/restore',
      body: { file: FILE, passphrase: PASSPHRASE, dryRun: true, sections: ['settings', 'credentials', 'skills'] },
    });
    expect(within(dialog).getByText('Settings fields that change: model, judge')).toBeDefined();
    expect(within(dialog).getByText(/••••q7q7/)).toBeDefined();
    expect(within(dialog).getByText(/Restored keys are not tested/)).toBeDefined();

    await user.click(restoreNow);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('Settings restored')).toBeDefined());
    expect(calls[1]?.body).toMatchObject({ dryRun: false, sections: ['settings', 'credentials', 'skills'] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the skills section and previews the skills written and the missing ones (ADR-0034)', async () => {
    const user = userEvent.setup();
    restoreAnswer = () =>
      new Response(
        JSON.stringify({ ...PREVIEW, sections: ['bots', 'skills'], bots: 2, skills: 3, skillsMissing: ['Security', 'Owner rules'] }),
        { status: 200 },
      );
    renderCard();
    await user.click(screen.getByRole('button', { name: /Restore from file/ }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Review skills (updated by name)') as HTMLInputElement).checked).toBe(true);

    await user.upload(within(dialog).getByLabelText('Backup file'), new File([JSON.stringify(FILE)], 'b.json', { type: 'application/json' }));
    await previewWhenReady(dialog);

    await waitFor(() => expect(within(dialog).getByText('Skills written: 3')).toBeDefined());
    expect(calls[0]?.body.sections).toEqual(['settings', 'bots', 'credentials', 'skills']);
    expect(
      within(dialog).getByText('Skills that will not exist; the bots naming them restore on Default: Security, Owner rules'),
    ).toBeDefined();
  });

  it('shows a wrong passphrase and a broken file in the dialog, and restores nothing without confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    restoreAnswer = () =>
      new Response(JSON.stringify({ error: { code: 'bad_passphrase', message: 'Wrong passphrase, or the file was changed' } }), { status: 400 });
    renderCard();
    await user.click(screen.getByRole('button', { name: /Restore from file/ }));
    const dialog = screen.getByRole('dialog');

    await user.upload(within(dialog).getByLabelText('Backup file'), new File(['{ not json'], 'bad.json', { type: 'application/json' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This file is not valid JSON.');

    await user.upload(within(dialog).getByLabelText('Backup file'), new File([JSON.stringify(FILE)], 'b.json', { type: 'application/json' }));
    await previewWhenReady(dialog);
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Wrong passphrase, or the file was changed.'));

    restoreAnswer = () => new Response(JSON.stringify(PREVIEW), { status: 200 });
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(within(dialog).getByText('What will change')).toBeDefined());
    await user.click(within(dialog).getByRole('button', { name: 'Restore now' }));
    expect(calls.filter((c) => c.body.dryRun === false)).toEqual([]);
  });
});
