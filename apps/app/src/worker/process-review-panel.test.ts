import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@mergepilot/engine';
import { buildMarker, renderFindingComment } from '@mergepilot/github';
import { BASE_URL, finding, HEAD, panelSetup, PUBLISHER, WS } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// The reviewer panel (ADR-0017), shared behaviour and separate mode.

const hashOf = (provider: string, model: string) =>
  createHash('sha256').update(JSON.stringify({ provider, model, language: 'en' })).digest('hex').slice(0, 12);

describe('processReviewJob — reviewer panel orchestration', () => {
  it('with no active extra bot the output is the single-bot review: no header, no bot marker, no panel logs', async () => {
    const h = await panelSetup({ bots: [{ slot: 2, active: false }], findings: { 'main-model': [finding('Main issue')] } });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.calledModels).toEqual(['main-model']); // the inactive bot is not run
    const runs = await h.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ botSlot: 1, botName: 'MergePilot', status: 'completed', provider: 'anthropic', model: 'main-model' });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.body.startsWith('## MergePilot review')).toBe(true);
    expect(h.created[0]?.body).toContain(`<!-- mergepilot:review head=${HEAD} config=${hashOf('anthropic', 'main-model')} -->`);
    expect(h.created[0]?.comments[0]?.body).not.toContain('mergepilot:bot=');
    expect([...h.events('panel.start'), ...h.events('panel.bot.done'), ...h.events('panel.publish')]).toEqual([]);
    expect(h.events('job.end')[0]).not.toHaveProperty('botSlot');
  });

  it('runs 3 bots in parallel; each records its own run and publishes with its own marker and header', async () => {
    const h = await panelSetup({
      bots: [{ slot: 2 }, { slot: 3, name: 'Fox', logo: 'fox', provider: 'gemini', model: 'g-model' }],
      findings: { 'main-model': [finding('Main issue')], 'bot2-model': [finding('Owl issue')], 'g-model': [finding('Fox issue')] },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.flight.max).toBe(3);
    const runs = await h.runs();
    expect(runs.map((r) => [r.botSlot, r.botName, r.status, r.provider, r.model, r.findingsCount, r.jobId])).toEqual([
      [1, 'MergePilot', 'completed', 'anthropic', 'main-model', 1, 'del-panel'],
      [2, 'Bot 2', 'completed', 'openai', 'bot2-model', 1, 'del-panel'],
      [3, 'Fox', 'completed', 'gemini', 'g-model', 1, 'del-panel'],
    ]);
    expect(new Set(runs.map((r) => r.reviewUrl)).size).toBe(3);

    expect(h.created).toHaveLength(3);
    const bySlot = (slot: number) => h.created.find((c) => c.body.includes(slot === 1 ? 'MergePilot** ·' : slot === 2 ? 'Bot 2**' : 'Fox**'))!;
    expect(bySlot(1).body.startsWith(`<img src="${BASE_URL}/bots/pilot.svg" width="20" height="20" alt=""> **MergePilot** · \`anthropic:main-model\``)).toBe(true);
    expect(bySlot(1).body).toContain(`config=${hashOf('anthropic', 'main-model')} -->`);
    expect(bySlot(1).comments[0]?.body).not.toContain('mergepilot:bot=');
    expect(bySlot(2).body).toContain(`<!-- mergepilot:review head=${HEAD} config=${hashOf('openai', 'bot2-model')} bot=2 -->`);
    expect(bySlot(2).comments[0]?.body.trimEnd().endsWith('<!-- mergepilot:bot=2 -->')).toBe(true);
    expect(bySlot(3).body.startsWith(`<img src="${BASE_URL}/bots/fox.svg"`)).toBe(true);
    expect(bySlot(3).body).toContain('bot=3 -->');

    expect(h.events('panel.start')[0]).toMatchObject({ bots: [1, 2, 3], mode: 'separate' });
    expect(h.events('panel.bot.done').map((e) => [e.slot, e.status, typeof e.ms])).toEqual(
      expect.arrayContaining([[1, 'completed', 'number'], [2, 'completed', 'number'], [3, 'completed', 'number']]),
    );
    expect(h.events('panel.publish')[0]).toMatchObject({ mode: 'separate', findings: 3 });
    expect(h.events('job.end').map((e) => e.botSlot).sort()).toEqual([1, 2, 3]);
    // The PR files are listed once for the whole panel.
    expect(h.client.listPullRequestFilesPage).toHaveBeenCalledTimes(1);
  });

  it('one bot throwing never stops the others', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }, { slot: 3, provider: 'gemini', model: 'g-model' }] });
    vi.mocked(h.deps.credentials.resolve).mockImplementation(async (_ws, provider) => {
      if (provider === 'openai') throw new Error('vault unavailable for openai');
      return new Secret('sk-panel-test-key-0000');
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    const runs = await h.runs();
    expect(runs.map((r) => [r.botSlot, r.status])).toEqual([[1, 'completed'], [2, 'failed'], [3, 'completed']]);
    expect(runs[1]?.detail).toContain('vault unavailable');
    expect(h.created).toHaveLength(2);
  });

  it('a failing model fails only its own bot', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }], failing: ['main-model'] });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('failed');
    expect((await h.runs()).map((r) => [r.botSlot, r.status])).toEqual([[1, 'failed'], [2, 'completed']]);
  });

  it('an extra bot whose provider has no stored key is recorded as skipped `no key` and never called', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }, { slot: 4, provider: 'gemini', model: 'g-model' }], noKey: ['gemini'] });
    await processReviewJob(h.job, h.deps);

    const runs = await h.runs();
    expect(runs.map((r) => [r.botSlot, r.status, r.detail])).toEqual([
      [1, 'completed', null],
      [2, 'completed', null],
      [4, 'skipped', 'no key'],
    ]);
    expect(runs[2]).toMatchObject({ provider: 'gemini', model: 'g-model', botName: 'Bot 4' });
    expect(h.calledModels.sort()).toEqual(['bot2-model', 'main-model']);
    expect(h.createModelForProvider.mock.calls.map(([c]) => c.model)).not.toContain('g-model');
  });

  it('the monthly budget, checked once, skips every bot; only the main bot publishes the notice', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }, { slot: 3 }], settings: { monthlyBudgetUsd: 1 }, monthlyCost: 2 });
    const result = await processReviewJob(h.job, h.deps);

    expect(result).toEqual({ status: 'skipped', detail: 'monthly budget reached' });
    expect(h.createModelForProvider).not.toHaveBeenCalled();
    const runs = (await h.runs()).filter((r) => r.headSha === HEAD);
    expect(runs.map((r) => [r.botSlot, r.status, r.detail])).toEqual([
      [1, 'skipped', 'monthly budget reached'],
      [2, 'skipped', 'monthly budget reached'],
      [3, 'skipped', 'monthly budget reached'],
    ]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.body).toContain('monthly budget reached');
    expect(h.created[0]?.body).not.toContain('bot=');
  });

  it('an active run of one slot skips only that slot', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }, { slot: 3 }] });
    const other = await h.store.createReviewRun({
      workspaceId: WS, jobId: 'other-job', installationId: 31, repoFullName: 'acme/repo', pullNumber: 7, headSha: HEAD,
      status: 'running', costUsd: null, detail: null, botSlot: 2, botName: 'Bot 2',
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    const runs = await h.runs();
    expect(runs.find((r) => r.id === other.id)?.status).toBe('running');
    expect(runs.filter((r) => r.jobId === 'del-panel').map((r) => [r.botSlot, r.status])).toEqual([[1, 'completed'], [3, 'completed']]);
    expect(h.calledModels.sort()).toEqual(['bot3-model', 'main-model']);
  });

  it('a paused PR skips every bot', async () => {
    const h = await panelSetup({ bots: [{ slot: 2 }] });
    h.client.getPullRequest = async () => ({ head: { sha: HEAD }, labels: [{ name: 'mergepilot:paused' }] });
    h.client.listIssueCommentsPage = async () => [];
    h.client.createIssueComment = async () => ({ id: 1 });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('skipped');
    expect((await h.runs()).map((r) => [r.botSlot, r.status, r.detail])).toEqual([
      [1, 'skipped', 'automatic reviews are paused on this PR'],
      [2, 'skipped', 'automatic reviews are paused on this PR'],
    ]);
  });
});

describe('processReviewJob — separate mode, per-bot history', () => {
  it("bot 2's own review of this head does not block bot 3, and blocks bot 2", async () => {
    const h = await panelSetup({
      bots: [{ slot: 2 }, { slot: 3 }],
      reviews: [{ id: 5, body: `old\n\n${buildMarker({ headSha: HEAD, configHash: hashOf('openai', 'bot2-model'), bot: 2 })}`, user: { login: PUBLISHER } }],
    });
    await processReviewJob(h.job, h.deps);
    // Bot 2 already reviewed this head: nothing new, no model call, nothing published.
    expect(h.calledModels.sort()).toEqual(['bot3-model', 'main-model']);
    expect(h.created.map((c) => (c.body.match(/bot=(\d)/) ?? [])[1] ?? '1').sort()).toEqual(['1', '3']);
    expect((await h.runs()).find((r) => r.botSlot === 2)?.detail).toBe('no new changes since the last review');
  });

  it('the incremental base and dedupe use only the same bot\'s reviews and comments; old markers are slot 1', async () => {
    const issue = finding('Shared issue');
    const engineFinding = { id: 'x', side: 'RIGHT' as const, ...issue } as Parameters<typeof renderFindingComment>[0];
    const h = await panelSetup({
      bots: [{ slot: 2 }, { slot: 3 }],
      findings: { 'main-model': [issue], 'bot2-model': [issue], 'bot3-model': [issue] },
      reviews: [
        // An old (pre-panel) review: slot 1's base.
        { id: 6, body: buildMarker({ headSha: 'sha-old', configHash: hashOf('anthropic', 'main-model') }), user: { login: PUBLISHER } },
      ],
      comments: [
        { id: 1, path: 'src/app.ts', line: 2, user: { login: PUBLISHER }, body: renderFindingComment(engineFinding, { language: 'en', suggestionsAsCode: false, botSlot: 2 }) },
      ],
    });
    h.client.compareCommits = async () => ({
      status: 'ahead', totalCommits: 1,
      files: [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1,1 +1,2 @@\n context\n+added line' }],
    });
    await processReviewJob(h.job, h.deps);

    const body = (slot: number) => h.created.find((c) => (slot === 1 ? !/ bot=\d/.test(c.body) : c.body.includes(`bot=${slot} -->`)))!;
    expect(body(1).body).toContain('Reviewed 1 new commit since `sha-old`');
    expect(body(2).body).toContain('Full review (first review)');
    expect(body(3).body).toContain('Full review (first review)');
    // Bot 2's earlier comment drops only bot 2's repeat of it.
    expect(body(1).comments).toHaveLength(1);
    expect(body(2).comments).toHaveLength(0);
    expect(body(3).comments).toHaveLength(1);
  });
});
