import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import * as client from '../api/client.js';
import { fakeSettingsServer, makeGroup, makeRun, renderRunsPage } from '../runs/runs-test-utils.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));
const mockNavigate = vi.fn();
vi.mock('react-router', async () => ({ ...(await vi.importActual('react-router')), useNavigate: () => mockNavigate }));

// acme/backend hashes to rose, acme/web to amber (see repo-colors.test.ts for the hash itself).
const backendPr7 = () =>
  makeGroup([
    makeRun({ id: 'b7-3', pullNumber: 7, status: 'running', inputTokens: null, outputTokens: null }),
    makeRun({ id: 'b7-2', pullNumber: 7, status: 'completed', inputTokens: 2000, outputTokens: 200, costUsd: 0.2 }),
    makeRun({ id: 'b7-1', pullNumber: 7, status: 'failed', inputTokens: 1000, outputTokens: 100, costUsd: 0.1 }),
  ]);
const webPr3 = () => makeGroup([makeRun({ id: 'w3', repoFullName: 'acme/web', pullNumber: 3 })]);
const backendPr9 = () => makeGroup([makeRun({ id: 'b9', pullNumber: 9, inputTokens: 1234567, outputTokens: 89 })]);

/** Top-level table rows (a PR group or a single-run PR); sub-rows have their own test id. */
const rows = () => screen.getAllByTestId(/^run-(row|group-row)$/);
const cellTexts = (row: HTMLElement) => [...row.querySelectorAll('td')].map((c) => c.textContent);

describe('RunsPage grouped by PR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.fetchApi).mockResolvedValue({});
  });

  it('numbers rows continuously across pages and puts #, selection and PR first', () => {
    renderRunsPage({ url: '/w/ws-1/runs?offset=25', groups: [backendPr7(), webPr3()], total: 27 });
    expect(cellTexts(rows()[0]!)[0]).toBe('26');
    expect(cellTexts(rows()[1]!)[0]).toBe('27');
    expect(cellTexts(rows()[1]!)[2]).toContain('web#3');
  });

  it('expands a PR with several runs into sub-rows; a single-run PR has no expander', () => {
    renderRunsPage({ groups: [backendPr7(), webPr3()] });
    const expander = screen.getByRole('button', { name: 'Show the runs of acme/backend#7' });
    expect(expander.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /acme\/web#3/ , expanded: false })).toBeNull();
    expect(screen.getByTitle('3 reviews of this pull request').textContent).toBe('×3');
    expect(screen.queryAllByTestId('run-sub-row')).toHaveLength(0);

    fireEvent.click(expander);
    const subRows = screen.getAllByTestId('run-sub-row');
    expect(subRows).toHaveLength(3);
    expect(cellTexts(subRows[0]!)[0]).toBe('1.1');
    expect(screen.getByRole('button', { name: 'Hide the runs of acme/backend#7' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(subRows[1]!);
    expect(mockNavigate).toHaveBeenCalledWith('/w/ws-1/runs/b7-2');

    // Clicking the parent row toggles it too (and does not navigate).
    fireEvent.click(screen.getByTestId('run-group-row'));
    expect(screen.queryAllByTestId('run-sub-row')).toHaveLength(0);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('shows summed tokens and cost on the parent row and "—" when usage is unknown', () => {
    renderRunsPage({ groups: [backendPr7(), webPr3(), backendPr9()] });
    const [parent, single, big] = rows();
    const parentCells = cellTexts(parent!);
    expect(parentCells).toContain('3,000');
    expect(parentCells).toContain('300');
    expect(parentCells).toContain('$0.3100');
    expect(cellTexts(single!).filter((c) => c === '—').length).toBeGreaterThanOrEqual(2);
    expect(cellTexts(big!)).toContain('1.2M');
    expect(big!.querySelector('[title="1,234,567"]')).not.toBeNull();
  });

  it('a parent checkbox selects its deletable runs, a sub-row checkbox one run, the header the page', () => {
    renderRunsPage({ groups: [backendPr7(), webPr3()] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select the runs of acme/backend#7' }));
    expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Show the runs of acme/backend#7' }));
    const subBoxes = screen.getAllByTestId('run-sub-row').map((r) => within(r).getByRole('checkbox'));
    expect((subBoxes[0] as HTMLInputElement).disabled).toBe(true); // running: never deleted
    fireEvent.click(subBoxes[1]!);
    expect(screen.getByRole('button', { name: 'Delete selected (1)' })).toBeDefined();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every run on this page' }));
    expect(screen.getByRole('button', { name: 'Delete selected (3)' })).toBeDefined();
  });

  it('deletes the selected runs after confirming and refreshes', async () => {
    vi.mocked(client.fetchApi).mockResolvedValueOnce({ deleted: 1 });
    renderRunsPage({ groups: [backendPr7(), webPr3()] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select the runs of acme/web#3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Delete 1 review records permanently/)).toBeDefined();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(client.fetchApi).toHaveBeenCalledWith('/api/workspaces/ws-1/runs/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: ['w3'] }),
      }),
    );
    expect(await screen.findByText('1 review records deleted')).toBeDefined();
  });

  it('above 100 rows the user must type the confirm word; deletes all matching with confirmCount', async () => {
    renderRunsPage({ url: '/w/ws-1/runs?repo=acme/web&status=failed', groups: [webPr3()], totalRuns: 150 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete all matching the filters (150)' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'nope' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(client.fetchApi).toHaveBeenCalledWith('/api/workspaces/ws-1/runs/delete', {
        method: 'POST',
        body: JSON.stringify({ filters: { repo: ['acme/web'], status: ['failed'] }, confirmCount: 150 }),
      }),
    );
  });

  it('members cannot select, delete or recolor', () => {
    renderRunsPage({ url: '/w/ws-1/runs?repo=acme/web', role: 'member', groups: [backendPr7(), webPr3()] });
    for (const box of screen.getAllByRole('checkbox')) expect((box as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /Change the color/ })).toBeNull();
  });

  it('colors every row of a repo the same, repos differently, and lists the page repos in the legend', () => {
    renderRunsPage({ groups: [backendPr7(), webPr3(), backendPr9()] });
    const [b7, w3, b9] = rows();
    expect(b7!.className).toContain('border-s-rose-500');
    expect(b9!.className).toContain('border-s-rose-500');
    expect(w3!.className).toContain('border-s-amber-500');
    fireEvent.click(screen.getByRole('button', { name: 'Show the runs of acme/backend#7' }));
    for (const sub of screen.getAllByTestId('run-sub-row')) expect(sub.className).toContain('border-s-rose-500');

    const legend = within(screen.getByRole('list', { name: 'Repositories on this page' }));
    expect(legend.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['acme/backend', 'acme/web']);
  });

  it('a chosen color wins over the hash; the legend picker saves it and recolors at once', async () => {
    const saved = fakeSettingsServer(client.fetchApi, { repoColors: { 'acme/web': 'violet' } });
    renderRunsPage({ groups: [backendPr7(), webPr3()], settings: { repoColors: { 'acme/web': 'violet' } } });
    expect(rows()[1]!.className).toContain('border-s-violet-500');

    fireEvent.click(screen.getByRole('button', { name: 'Change the color of acme/backend' }));
    fireEvent.click(screen.getByRole('button', { name: 'Teal' }));
    await waitFor(() => expect(rows()[0]!.className).toContain('border-s-teal-500'));
    expect(client.fetchApi).toHaveBeenCalledWith('/api/workspaces/ws-1/settings', {
      method: 'PUT',
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        language: 'en',
        repoColors: { 'acme/web': 'violet', 'acme/backend': 'teal' },
        base: { provider: 'anthropic', model: 'claude-sonnet-5-5', language: 'en', repoColors: { 'acme/web': 'violet' } },
      }),
    });

    // "Auto" removes the override, back to the hashed color.
    fireEvent.click(screen.getByRole('button', { name: 'Change the color of acme/web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    await waitFor(() => expect(rows()[1]!.className).toContain('border-s-amber-500'));
    await waitFor(() => expect(saved().repoColors).toEqual({ 'acme/backend': 'teal' }));
  });

  it('rolls the color back when saving fails', async () => {
    const saved = fakeSettingsServer(client.fetchApi, { repoColors: { 'acme/web': 'lime' } });
    vi.mocked(client.fetchApi).mockRejectedValueOnce(new Error('nope'));
    renderRunsPage({ groups: [webPr3()], settings: { repoColors: { 'acme/web': 'lime' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Change the color of acme/web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Indigo' }));
    expect(await screen.findByText('nope')).toBeDefined();
    expect(rows()[0]!.className).toContain('border-s-lime-500');
    expect(saved().repoColors).toEqual({ 'acme/web': 'lime' });
  });

  it('shows the owner too when two repos on the page share a name', () => {
    renderRunsPage({
      groups: [
        makeGroup([makeRun({ repoFullName: 'team-a/backend', pullNumber: 1 })]),
        makeGroup([makeRun({ repoFullName: 'team-b/backend', pullNumber: 1 })]),
        makeGroup([makeRun({ repoFullName: 'team-a/web', pullNumber: 2 })]),
      ],
    });
    const texts = rows().map((r) => cellTexts(r)[2]);
    expect(texts[0]).toContain('team-a/backend');
    expect(texts[1]).toContain('team-b/backend');
    expect(texts[2]).toContain('web');
    expect(texts[2]).not.toContain('team-a/web');
  });
  it('shows the API-equivalent of subscription runs under the cost, summed on the parent row', () => {
    const group = makeGroup([
      makeRun({ id: 's2', pullNumber: 11, costUsd: 0, apiEquivalentUsd: 0.02 }),
      makeRun({ id: 's1', pullNumber: 11, costUsd: 0, apiEquivalentUsd: 0.01 }),
    ]);
    renderRunsPage({ groups: [group] });
    expect(cellTexts(rows()[0]!)).toContain('$0.0000≈ $0.0300');

    fireEvent.click(screen.getByRole('button', { name: 'Show the runs of acme/backend#11' }));
    expect(cellTexts(screen.getAllByTestId('run-sub-row')[0]!)).toContain('$0.0000≈ $0.0200');
  });

});
