import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BotsResponse } from '../../api/bots.js';
import { ApiClientError, fetchApi } from '../../api/client.js';
import type { SkillSummary } from '../../api/skills.js';
import { ToastProvider } from '../../components/Toast.js';
import { readFileText } from '../read-file-text.js';
import { renderSettings } from '../settings.fixtures.js';
import { SkillsCard } from './SkillsCard.js';
import { SKILL_TEMPLATES } from './templates.js';

vi.mock('../../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client.js')>();
  return { ...actual, fetchApi: vi.fn() };
});

// The browser's file read (FileReader) is the boundary; real by default, held open in one test.
vi.mock('../read-file-text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../read-file-text.js')>();
  return { readFileText: vi.fn(actual.readFileText) };
});

const SKILL_ID = '00000000-0000-4000-8000-000000000001';

const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: SKILL_ID,
  name: 'Security',
  sizeTokens: 812,
  contentHash: 'h'.repeat(64),
  updatedAt: '2026-10-17T10:00:00.000Z',
  usedBy: [],
  ...overrides,
});

const BOTS: BotsResponse = {
  main: { slot: 1, name: 'MergePilot', logo: 'pilot', active: true, provider: 'anthropic', model: 'm', effort: null, fallback: [] },
  bots: [{ slot: 3, name: 'Fox bot', logo: 'fox', active: true, provider: 'openai', model: 'o', effort: null, fallback: [] }],
  panel: { mode: 'separate', minAgreement: 1 },
  logos: ['pilot', 'fox'],
};

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** Answers like the skills API; a POST naming a taken name answers 409 `skill_name_taken`. */
function fakeSkillsServer(skills: SkillSummary[], content = '# Skill') {
  const calls: Call[] = [];
  vi.mocked(fetchApi).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    if (path.endsWith('/bots')) return BOTS;
    if (path.endsWith('/skills') && method === 'GET') {
      return { skills, limits: { maxSkills: 50, maxTokens: 8000, maxNameLength: 60 } };
    }
    if (path.endsWith('/skills') && method === 'POST') {
      if (skills.some((s) => s.name.toLowerCase() === String(body?.['name']).toLowerCase())) {
        throw new ApiClientError('A skill with this name exists', 'skill_name_taken', 409);
      }
      return { skill: { ...skill({ name: String(body?.['name']) }), content: String(body?.['content']) } };
    }
    if (method === 'DELETE') return undefined;
    return { skill: { ...skills[0], content } };
  });
  return { calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

/** A skill's table row (the template buttons may carry the same name). */
const findRow = async (name: string) => (await screen.findByRole('cell', { name })).closest('tr') as HTMLElement;

const renderCard = (isMember = false) =>
  renderSettings(
    <ToastProvider>
      <SkillsCard workspaceId="ws-1" isMember={isMember} />
    </ToastProvider>,
    'en',
  );

describe('SkillsCard (ADR-0034)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists each skill with its size against the cap and the bots using it', async () => {
    fakeSkillsServer([skill({ usedBy: [3, 1] })]);
    renderCard();
    const row = await findRow('Security');
    expect(within(row).getByText('812 / 8,000 tokens')).toBeDefined();
    await waitFor(() => expect(within(row).getByText('MergePilot, Fox bot')).toBeDefined());
  });

  it('uploads a Markdown file under the typed name, and refuses another extension before sending', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const server = fakeSkillsServer([]);
    renderCard();
    await screen.findByText('This workspace has no skills yet.');
    const fileInput = screen.getByLabelText('Markdown file (.md or .markdown)');

    await user.upload(fileInput, new File(['plain'], 'notes.txt', { type: 'text/plain' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Only .md and .markdown files are accepted');

    await user.upload(fileInput, new File(['# Rules\n- one'], 'team-rules.md', { type: 'text/markdown' }));
    // The name defaults to the file name; the admin can change it.
    await waitFor(() => expect((screen.getByLabelText('Skill name') as HTMLInputElement).value).toBe('team-rules'));
    await user.clear(screen.getByLabelText('Skill name'));
    await user.type(screen.getByLabelText('Skill name'), 'Team rules');
    await user.click(screen.getByRole('button', { name: 'Upload skill' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toEqual({
      method: 'POST',
      path: '/api/workspaces/ws-1/skills',
      body: { name: 'Team rules', content: '# Rules\n- one' },
    });
  });

  it('adds a template as a new skill with a free name', async () => {
    const user = userEvent.setup();
    const server = fakeSkillsServer([skill({ name: 'security' })]);
    renderCard();
    await findRow('security');
    await user.click(screen.getByRole('button', { name: 'Security' }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    const security = SKILL_TEMPLATES.find((t) => t.id === 'security');
    expect(security?.content).toMatch(/^# Security/);
    // "Security" is taken (names are unique ignoring case), so the next free name.
    expect(server.writes()[0]?.body).toEqual({ name: 'Security 2', content: security?.content });
  });

  it('will not save an edit while the picked replacement file was refused', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const server = fakeSkillsServer([skill()]);
    renderCard();
    await user.click(within(await findRow('Security')).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Skill name'));
    await user.type(within(dialog).getByLabelText('Skill name'), 'Security v2');
    await user.upload(within(dialog).getByLabelText('New file (optional)'), new File(['x'], 'rules.txt', { type: 'text/plain' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toBe('Only .md and .markdown files are accepted');
    expect(server.writes()).toHaveLength(0);
  });

  it('will not save an edit while the replacement file is still being read', async () => {
    const user = userEvent.setup();
    const server = fakeSkillsServer([skill()]);
    vi.mocked(readFileText).mockReturnValueOnce(new Promise(() => undefined));
    renderCard();
    await user.click(within(await findRow('Security')).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Skill name'));
    await user.type(within(dialog).getByLabelText('Skill name'), 'Security v2');
    await user.upload(within(dialog).getByLabelText('New file (optional)'), new File(['# v2'], 'rules.md', { type: 'text/markdown' }));

    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    await user.click(save);
    expect(server.writes()).toHaveLength(0);
  });

  it('confirms a delete in the page, naming the bots that fall back to the core prompt', async () => {
    const user = userEvent.setup();
    const server = fakeSkillsServer([skill({ usedBy: [1, 3] })]);
    renderCard();
    const row = await findRow('Security');
    await waitFor(() => expect(within(row).getByText('MergePilot, Fox bot')).toBeDefined());
    await user.click(within(row).getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete "Security"?')).toBeDefined();
    expect(
      within(dialog).getByText(
        'These bots use this skill: MergePilot, Fox bot. After the delete they review with the core prompt only, and their next review of each open pull request will be a full one.',
      ),
    ).toBeDefined();
    expect(server.writes()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(server.writes()).toEqual([{ method: 'DELETE', path: `/api/workspaces/ws-1/skills/${SKILL_ID}`, body: undefined }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the content as plain text, never as HTML', async () => {
    const user = userEvent.setup();
    const content = '<script>alert(1)</script>\n<b>bold</b>';
    fakeSkillsServer([skill()], content);
    renderCard();
    await user.click(await screen.findByRole('button', { name: 'Preview' }));

    const pre = await screen.findByLabelText('Content of "Security"');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe(content);
    expect(pre.querySelector('script, b')).toBeNull();
  });

  it('gives members a read-only list: preview only, no upload, template, edit or delete', async () => {
    fakeSkillsServer([skill()]);
    renderCard(true);
    const row = await findRow('Security');
    expect(within(row).getByRole('button', { name: 'Preview' })).toBeDefined();
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByLabelText('Skill name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload skill' })).toBeNull();
    expect(screen.queryByText('Add from template')).toBeNull();
  });
});
