import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api/client.js';
import type { SkillSummary } from '../../api/skills.js';
import { CATALOG, extraBot, fakeBotsServer, MAIN_SETTINGS, renderPanel } from './bots-test-utils.js';

vi.mock('../../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client.js')>();
  return { ...actual, fetchApi: vi.fn(), api: { ...actual.api, getModels: vi.fn() } };
});

const SECURITY_ID = '00000000-0000-4000-8000-0000000000a1';
const SKILLS: SkillSummary[] = [
  { id: SECURITY_ID, name: 'Security', sizeTokens: 800, contentHash: 'a'.repeat(64), updatedAt: '2026-10-17T10:00:00.000Z', usedBy: [] },
];

describe('Per-bot skill dropdown (ADR-0034)', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModels).mockResolvedValue(CATALOG);
  });

  it('an extra bot saves the chosen skill through PUT /bots/:slot', async () => {
    const server = fakeBotsServer({ bots: [extraBot(2, { name: 'Owl bot' })], skills: SKILLS });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: /Owl bot/ }));
    const select = screen.getByLabelText('Skill') as HTMLSelectElement;
    expect(select.value).toBe('');
    await screen.findByRole('option', { name: 'Security' });

    await user.selectOptions(select, 'Security');
    await user.click(screen.getByRole('button', { name: 'Save bot' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ method: 'PUT', path: '/api/workspaces/ws-1/bots/2', body: { skillId: SECURITY_ID } });
  });

  it('the main bot shows the deleted-skill note on Default and saves a new choice with the settings', async () => {
    const settings = { ...MAIN_SETTINGS, skillId: null, skillRemovedName: 'Old rules' };
    fakeBotsServer({ settings, skills: SKILLS });
    const { onSave } = renderPanel({ settings });
    expect(screen.getByText('The skill "Old rules" was deleted; this bot now reviews with the core prompt only.')).toBeDefined();

    await screen.findByRole('option', { name: 'Security' });
    await user.selectOptions(screen.getByLabelText('Skill'), 'Security');
    // The note is about the Default the bot fell back to, so a new choice hides it.
    expect(screen.queryByText(/was deleted; this bot now reviews/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ skillId: SECURITY_ID }));
  });
});
