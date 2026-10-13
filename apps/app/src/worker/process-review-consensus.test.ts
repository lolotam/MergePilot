import { describe, expect, it, vi } from 'vitest';
import type { JudgeSettings } from '../core/types.js';
import { BASE_URL, finding, HEAD, panelSetup } from './panel.fixtures.js';
import { processReviewJob } from './process-review.js';

// The reviewer panel in consensus mode (ADR-0017): the bots review without publishing, then one
// merged review is published as slot 1.

const consensus = (minAgreement = 1) => ({ panelMode: 'consensus' as const, panelMinAgreement: minAgreement });

describe('processReviewJob — consensus mode', () => {
  it('merges findings by title and line and publishes one «Review panel» review as slot 1', async () => {
    const h = await panelSetup({
      settings: consensus(2),
      bots: [{ slot: 2, name: 'Owl' }, { slot: 3, name: 'Fox', provider: 'gemini', model: 'g-model' }],
      findings: {
        'main-model': [finding('Null dereference')],
        'bot2-model': [finding('null dereference!')],
        'g-model': [finding('Style nit')],
      },
    });
    const result = await processReviewJob(h.job, h.deps);

    expect(result.status).toBe('completed');
    expect(h.flight.max).toBe(3);
    expect(h.created).toHaveLength(1);
    const review = h.created[0]!;
    expect(review.body.startsWith('## Review panel')).toBe(true);
    expect(review.body).toMatch(new RegExp(`<!-- mergepilot:review head=${HEAD} config=[a-f0-9]{12} -->$`));
    // The summary table: one row per bot.
    expect(review.body).toContain(`| <img src="${BASE_URL}/bots/pilot.svg" width="20" height="20" alt=""> | **MergePilot** | \`anthropic:main-model\` | ✅ completed | 1 |`);
    expect(review.body).toContain('| **Owl** | `openai:bot2-model` | ✅ completed | 1 |');
    expect(review.body).toContain('| **Fox** | `gemini:g-model` | ✅ completed | 1 |');
    // The agreed finding is the one inline comment, labelled with who found it.
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]?.body).toContain('_Found by: MergePilot, Owl (2/3)_');
    expect(review.comments[0]?.body).not.toContain('mergepilot:bot=');
    // The lone low finding is listed, not dropped silently.
    expect(review.body).toContain('<summary>Below agreement (1)</summary>');
    expect(review.body).toContain('Style nit · _Found by: Fox (1/3)_');

    const runs = await h.runs();
    expect(runs.map((r) => [r.botSlot, r.status, r.findingsCount, r.reviewUrl])).toEqual([
      [1, 'completed', 1, 'https://github.com/acme/repo/pull/7#pullrequestreview-1001'],
      [2, 'completed', 1, 'https://github.com/acme/repo/pull/7#pullrequestreview-1001'],
      [3, 'completed', 1, 'https://github.com/acme/repo/pull/7#pullrequestreview-1001'],
    ]);
    expect(runs.every((r) => r.result?.usage?.inputTokens)).toBe(true);
    expect(h.events('panel.publish')[0]).toMatchObject({ mode: 'consensus', findings: 1 });
    expect(h.events('panel.start')[0]).toMatchObject({ mode: 'consensus', bots: [1, 2, 3] });
  });

  it('keeps critical and high findings below the minimum agreement', async () => {
    const h = await panelSetup({
      settings: consensus(3),
      bots: [{ slot: 2 }],
      findings: { 'main-model': [finding('Injection', 'critical')], 'bot2-model': [finding('Race', 'high', 1)] },
    });
    await processReviewJob(h.job, h.deps);
    const titles = h.created[0]?.comments.map((c) => c.body.split('\n')[0]);
    expect(titles?.sort()).toEqual(['### Injection', '### Race']);
    expect(h.created[0]?.body).not.toContain('Below agreement');
  });

  it('a failed bot is shown in the table and counted out of N', async () => {
    const h = await panelSetup({
      settings: consensus(1),
      bots: [{ slot: 2, name: 'Owl' }],
      failing: ['bot2-model'],
      findings: { 'main-model': [finding('Null dereference')] },
    });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('completed');
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.body).toContain('| **Owl** | `openai:bot2-model` | ❌ failed |');
    expect(h.created[0]?.comments[0]?.body).toContain('_Found by: MergePilot (1/1)_');
    expect((await h.runs()).map((r) => r.status)).toEqual(['completed', 'failed']);
    // A failed member never saw these changes: the panel review stays partial, so the head is reviewed again.
    expect(h.created[0]?.body).toMatch(/<!-- mergepilot:review head=\S+ config=[a-f0-9]{12} status=partial -->$/);
    expect(h.created[0]?.body).toContain('Owl: did not complete');
  });

  it('does not run or publish when another job holds the main bot run (no slot-1 race)', async () => {
    const h = await panelSetup({ settings: consensus(1), bots: [{ slot: 2, name: 'Owl' }] });
    await h.store.createReviewRun({
      workspaceId: 'ws-panel', jobId: 'other-job', installationId: 31, repoFullName: 'acme/repo', pullNumber: 7,
      headSha: h.job.headSha, status: 'running', costUsd: null, detail: null,
    });
    const result = await processReviewJob(h.job, h.deps);
    expect(result).toEqual({ status: 'skipped', detail: 'duplicate' });
    expect(h.created).toHaveLength(0);
    expect(h.calledModels).toEqual([]);
    const mine = (await h.runs()).filter((r) => r.jobId === h.job.deliveryId);
    expect(mine.map((r) => [r.botSlot, r.status, r.detail])).toEqual([[2, 'skipped', 'duplicate']]);
  });

  it('publishes nothing when every bot failed', async () => {
    const h = await panelSetup({ settings: consensus(1), bots: [{ slot: 2 }], failing: ['main-model', 'bot2-model'] });
    const result = await processReviewJob(h.job, h.deps);
    expect(result.status).toBe('failed');
    expect(h.created).toHaveLength(0);
    const runs = await h.runs();
    expect(runs.map((r) => [r.botSlot, r.status, r.reviewUrl])).toEqual([[1, 'failed', null], [2, 'failed', null]]);
    expect(h.events('panel.publish')[0]).toMatchObject({ mode: 'consensus', findings: 0 });
  });

  it('asks the workspace judge whether differently worded findings are the same issue', async () => {
    const judge: JudgeSettings = { enabled: true, provider: 'typesafe', model: 'jev-latest', mode: 'filter', threshold: 0.35, fallback: [] };
    const h = await panelSetup({
      settings: { ...consensus(2), judge, minSeverity: 'low' },
      bots: [{ slot: 2, name: 'Owl' }],
      findings: { 'main-model': [finding('Possible null pointer')], 'bot2-model': [finding('Missing null check')] },
    });
    const asked: string[][] = [];
    h.deps.judgeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const ids = Object.keys((JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions);
      asked.push(ids);
      const answers = Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: 0.9 }]));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 0 } }), { status: 200 });
    });
    await processReviewJob(h.job, h.deps);

    // One false-positive filter call per bot, then one same-issue call for the merge.
    expect(asked.filter((ids) => ids[0]?.startsWith('p'))).toHaveLength(1);
    expect(h.created[0]?.comments).toHaveLength(1);
    expect(h.created[0]?.comments[0]?.body).toContain('_Found by: MergePilot, Owl (2/2)_');
    expect(h.created[0]?.body).not.toContain('Below agreement');
  });

  it('uses slot 1\'s marker as the incremental base for the whole panel', async () => {
    const h = await panelSetup({ settings: consensus(1), bots: [{ slot: 2 }] });
    await processReviewJob(h.job, h.deps);
    expect(h.created).toHaveLength(1);
    // The same head again: slot 1's panel review covers it, so no bot runs a model.
    const again = await panelSetup({ settings: consensus(1), bots: [{ slot: 2 }], reviews: [{ id: 9, body: h.created[0]!.body, user: { login: 'mergepilot[bot]' } }] });
    await processReviewJob(again.job, again.deps);
    expect(again.calledModels).toEqual([]);
    expect(again.created).toHaveLength(0);
    expect((await again.runs()).map((r) => [r.botSlot, r.status, r.detail])).toEqual([
      [1, 'skipped', 'no new changes since the last review'],
      [2, 'skipped', 'no new changes since the last review'],
    ]);
  });
});
