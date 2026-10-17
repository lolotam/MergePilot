import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { BotsResponse } from '../api/bots.js';
import * as client from '../api/client.js';
import { makeGroup, makeRun, renderRunsPage } from './runs-test-utils.js';
import { runBotLogo, showsRunBot } from './RunBotChip.js';

vi.mock('../api/hooks.js');
vi.mock('../api/client.js', async () => ({ ...(await vi.importActual('../api/client.js')), fetchApi: vi.fn() }));
vi.mock('react-router', async () => ({ ...(await vi.importActual('react-router')), useNavigate: () => vi.fn() }));

const BOTS: BotsResponse = {
  main: { slot: 1, name: 'MergePilot', logo: 'pilot', active: true, provider: 'anthropic', model: 'm', effort: null, fallback: [] },
  bots: [{ slot: 2, name: 'Owl bot', logo: 'owl', active: true, provider: 'openai', model: 'o', effort: null, fallback: [] }],
  panel: { mode: 'separate', minAgreement: 1 },
  logos: ['pilot', 'owl'],
};

const chips = () => screen.queryAllByTestId('run-bot-chip');

describe('bot chip on runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.fetchApi).mockImplementation(async (path: string) => (path.endsWith('/bots') ? BOTS : {}));
  });

  it('is hidden in a single-bot workspace, so the table looks unchanged', () => {
    renderRunsPage({
      groups: [makeGroup([makeRun({ id: 'a', pullNumber: 1 })]), makeGroup([makeRun({ id: 'b', pullNumber: 2, botSlot: 1, botName: 'MergePilot' })])],
    });
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    expect(chips()).toHaveLength(0);
  });

  it("shows an extra bot's run with its logo and name", async () => {
    renderRunsPage({ groups: [makeGroup([makeRun({ id: 'x', botSlot: 2, botName: 'Owl bot' })])] });
    const chip = within(screen.getByTestId('run-row')).getByTestId('run-bot-chip');
    // A letter until the bots load, then the preset logo.
    await waitFor(() => expect(chip.querySelector('img')?.getAttribute('src')).toBe('/bots/owl.svg'));
    expect(chip.textContent).toBe('Owl bot');
  });

  it('shows every sub-row of a PR reviewed by several bots, the main one as MergePilot', async () => {
    renderRunsPage({
      groups: [
        makeGroup([
          makeRun({ id: 'r2', pullNumber: 7, botSlot: 2, botName: 'Owl bot' }),
          makeRun({ id: 'r1', pullNumber: 7, botSlot: 1, botName: null }),
        ]),
      ],
    });
    expect(chips()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show the runs of acme/backend#7' }));
    await waitFor(() => expect(chips().map((c) => c.textContent)).toEqual(['Owl bot', 'MergePilot']));
  });

  it('names an older main-bot run (no name snapshot) after the main bot as it is now', async () => {
    const renamed = { ...BOTS, main: { ...BOTS.main, name: 'Captain' } };
    vi.mocked(client.fetchApi).mockImplementation(async (path: string) => (path.endsWith('/bots') ? renamed : {}));
    renderRunsPage({ groups: [makeGroup([makeRun({ id: 'r1', botSlot: 1, botName: null }), makeRun({ id: 'r2', botSlot: 2, botName: 'Owl bot' })])] });
    fireEvent.click(screen.getByRole('button', { name: /Show the runs of/ }));
    await waitFor(() => expect(chips().map((c) => c.textContent)).toContain('Captain'));
  });

  it("shows the run's skill by name next to the bot, and nothing on Default (ADR-0034)", () => {
    renderRunsPage({
      groups: [
        makeGroup([makeRun({ id: 's', pullNumber: 1, skillName: 'Security' })]),
        makeGroup([makeRun({ id: 'd', pullNumber: 2, skillName: null })]),
      ],
    });
    expect(screen.getAllByTestId('run-skill-name').map((el) => el.textContent)).toEqual(['Skill: Security']);
  });

  it('logo lookup: slot 1 is the main bot; an extra slot only while it keeps the run name', () => {
    expect(runBotLogo(BOTS, 1, null)).toBe('pilot');
    expect(runBotLogo(BOTS, 2, 'owl BOT')).toBe('owl');
    expect(runBotLogo(BOTS, 2, 'Deleted bot')).toBeUndefined();
    expect(runBotLogo(BOTS, 3, 'Gone')).toBeUndefined();
    expect(runBotLogo(undefined, 1, null)).toBeUndefined();
  });

  it('showsRunBot: slot > 1, or runs that span several bots', () => {
    expect(showsRunBot({ botSlot: 1 }, [{ botSlot: 1 }, {}])).toBe(false);
    expect(showsRunBot({ botSlot: 3 }, [{ botSlot: 3 }])).toBe(true);
    expect(showsRunBot({}, [{}, { botSlot: 2 }])).toBe(true);
  });
});
