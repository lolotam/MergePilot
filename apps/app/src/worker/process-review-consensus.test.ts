import { describe, expect, it, vi } from 'vitest';
import { renderFindingComment } from '@mergepilot/github';
import type { JudgeSettings } from '../core/types.js';
import { BASE_URL, finding, HEAD, panelSetup, PUBLISHER } from './panel.fixtures.js';
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
      bots: [{ slot: 2, name: 'Owl', exploreEnabled: true }],
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
    expect(h.created[0]?.body).toContain('> ℹ️ **Owl**: Explored:');
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
    // The other job's main run is never touched: only this job's own rows are closed.
    const other = (await h.runs()).filter((r) => r.jobId === 'other-job');
    expect(other.map((r) => [r.botSlot, r.status])).toEqual([[1, 'running']]);
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
    const judge: JudgeSettings = { enabled: true, provider: 'typesafe', model: 'jev-latest', uses: ['filter', 'consensus'], threshold: 0.35, fallback: [] };
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

  // PayPos.systems#361: the same claim reported with different titles by two of four bots.
  const sameClaimFindings = {
    'main-model': [{
      ...finding('Equal-revision replays can replace authoritative snapshot figures'),
      body: 'After an uncertain save, a replacement snapshot can already contain that edit. Replaying the retained request ' +
        'passes this strict revision comparison, and the cached response replaces the session total and other lines.',
    }],
    'bot3-model': [{
      ...finding('Equal-revision replays overwrite fresher visit totals'),
      body: 'After an uncertain save, a refreshed snapshot may already include that edit plus changes to other lines. ' +
        'Replaying the retained key passes this strict revision comparison and replaces the refreshed session total.',
    }],
    'bot2-model': [{
      ...finding('Busy-kept editor closes without showing a known refusal'),
      body: 'The editor stays open only while editBusy is true; when the lock drops, a refused save unmounts the form ' +
        'and its error message is never visible.',
    }],
  };
  const fourBots = [{ slot: 2, name: 'Owl' }, { slot: 3, name: 'Fox' }, { slot: 4, name: 'Star' }];
  const consensusJudge = (fallback: JudgeSettings['fallback']): JudgeSettings => ({
    enabled: true, provider: 'typesafe', model: 'jev-latest', uses: ['consensus'], threshold: 0.35, fallback,
  });

  it('publishes one comment for the same claim by wording, whatever the judge answers, and names the judge that answered', async () => {
    const h = await panelSetup({
      settings: { ...consensus(1), judge: consensusJudge([{ provider: 'vercel-gateway', model: 'typesafe-ai/jev' }]) },
      bots: fourBots,
      findings: sameClaimFindings,
    });
    const asked: number[] = [];
    h.deps.judgeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('typesafe.ai')) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
      const ids = Object.keys((JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions);
      asked.push(ids.length);
      const answers = Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: 0.3 }]));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 0 } }), { status: 200 });
    });
    await processReviewJob(h.job, h.deps);

    // Only Owl's different issue goes to the judge (against each of the other two); its "no" splits nothing else.
    expect(asked).toEqual([2]);
    const bodies = h.created[0]!.comments.map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies.filter((b) => b.includes('_Found by: MergePilot, Fox (2/4)_'))).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('_Found by: Owl (1/4)_'))).toHaveLength(1);
    expect(h.created[0]?.body).toContain('> Jev: `vercel-gateway:typesafe-ai/jev (fallback 1; typesafe failed: auth)`');
  });

  it('still publishes one comment for the same claim when every judge entry fails, and says so', async () => {
    const h = await panelSetup({
      settings: { ...consensus(1), judge: consensusJudge([]) },
      bots: fourBots,
      findings: sameClaimFindings,
    });
    h.deps.judgeFetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 }));
    await processReviewJob(h.job, h.deps);

    const bodies = h.created[0]!.comments.map((c) => c.body);
    expect(bodies.filter((b) => b.includes('_Found by: MergePilot, Fox (2/4)_'))).toHaveLength(1);
    expect(bodies).toHaveLength(2);
    expect(h.created[0]?.body).toContain('> ⚠️ Jev same-issue check unavailable: server — findings were merged by title and wording only');
  });

  it('explains a table count that was not published: merged into another bot, below agreement, or already posted', async () => {
    const earlier = { id: 'old', side: 'RIGHT' as const, ...finding('Unclosed file handle') } as Parameters<typeof renderFindingComment>[0];
    const h = await panelSetup({
      settings: consensus(2),
      bots: [{ slot: 2, name: 'Owl' }],
      findings: {
        'main-model': [finding('Null dereference'), finding('Unclosed file handle')],
        'bot2-model': [finding('null dereference!'), finding('Unclosed file handle'), finding('Style nit')],
      },
      comments: [
        { id: 1, path: 'src/app.ts', line: 2, user: { login: PUBLISHER }, body: renderFindingComment(earlier, { language: 'en', suggestionsAsCode: false }) },
      ],
    });
    await processReviewJob(h.job, h.deps);

    const body = h.created[0]!.body;
    expect(body).toContain('> - **MergePilot** (1 of 2): 1 already posted by an earlier review');
    expect(body).toContain(
      "> - **Owl** (3 of 3): 1 presented in another bot's wording · 1 below agreement · 1 already posted by an earlier review",
    );
  });

  /** Consensus + dedupe judge whose primary fails, with an earlier slot-1 comment on the same line. */
  async function judgedAgainstEarlierComment(owlTitle: string, fallbackAnswers = Infinity) {
    const earlier = { id: 'old', side: 'RIGHT' as const, ...finding('Unclosed file handle') } as Parameters<typeof renderFindingComment>[0];
    const judge = { ...consensusJudge([{ provider: 'vercel-gateway', model: 'typesafe-ai/jev' }]), uses: ['consensus', 'dedupe'] } as JudgeSettings;
    const h = await panelSetup({
      settings: { ...consensus(1), judge },
      bots: [{ slot: 2, name: 'Owl' }],
      findings: { 'main-model': [finding('Null dereference')], 'bot2-model': [finding(owlTitle)] },
      comments: [
        { id: 1, path: 'src/app.ts', line: 2, user: { login: PUBLISHER }, body: renderFindingComment(earlier, { language: 'en', suggestionsAsCode: false }) },
      ],
    });
    const asked: number[] = [];
    h.deps.judgeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('typesafe.ai')) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
      if (asked.length >= fallbackAnswers) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
      const ids = Object.keys((JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions);
      asked.push(ids.length);
      const answers = Object.fromEntries(ids.map((id) => [id, { type: 'noul', noul: 0.1 }]));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10, output_tokens: 0 } }), { status: 200 });
    });
    await processReviewJob(h.job, h.deps);
    return { body: h.created[0]!.body, comments: h.created[0]!.comments, asked };
  }
  const fallbackLabel = 'vercel-gateway:typesafe-ai/jev (fallback 1; typesafe failed: auth)';

  it('names the fallback that answered the check against earlier comments, and no merge judge when the merge asked none', async () => {
    const { body, comments, asked } = await judgedAgainstEarlierComment('null dereference!');
    // The two titles merge without the judge; only the dedupe asks it, about the earlier comment.
    expect(asked).toEqual([1]);
    expect(comments[0]?.body).toContain('_Found by: MergePilot, Owl (2/2)_');
    expect(body).toContain(`> Jev (earlier comments): \`${fallbackLabel}\``);
    expect(body).not.toContain('> Jev: ');
  });

  it('names the judge entry for the merge and for the earlier comments when both asked it', async () => {
    const { body, asked } = await judgedAgainstEarlierComment('Missing null check');
    expect(asked).toEqual([1, 2]);
    expect(body).toContain(`> Jev: \`${fallbackLabel}\``);
    expect(body).toContain(`> Jev (earlier comments): \`${fallbackLabel}\``);
  });

  it('says the check against earlier comments was unavailable when every judge entry failed on it', async () => {
    const { body } = await judgedAgainstEarlierComment('null dereference!', 0);
    expect(body).toContain('> ⚠️ Jev duplicate check unavailable: server');
    expect(body).not.toContain('> Jev');
  });

  it('names the merge judge and flags the failed check against earlier comments', async () => {
    const { body, asked } = await judgedAgainstEarlierComment('Missing null check', 1);
    expect(asked).toEqual([1]);
    expect(body).toContain(`> Jev: \`${fallbackLabel}\``);
    expect(body).toContain('> ⚠️ Jev duplicate check unavailable: server');
    expect(body).not.toContain('> Jev (earlier comments)');
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


it.each([[['bot2-model']], [['main-model', 'bot2-model']]])('incorporates rejected copies and removes the contradictory rejection list: %s', async (rejectedModels) => {
  const h = await panelSetup({ settings: consensus(2), bots: [{ slot: 2, name: 'Owl' }],
    findings: { 'main-model': [finding('Shared issue')], 'bot2-model': [finding('Shared issue')] }, rejectedModels });
  await processReviewJob(h.job, h.deps);
  expect(h.created[0]!.comments).toHaveLength(1);
  expect(h.created[0]!.comments[0]!.body).toContain('(2/2)');
  expect(h.created[0]!.body).not.toContain('<summary>Rejected by verification');
  expect(h.created[0]!.body).toContain('verifier-rejected copies contributed');
  for (const run of await h.runs()) expect(run.result).not.toHaveProperty('verifyRejectedFindings');
});

it('deduplicates revived findings against earlier comments before applying the normal cap', async () => {
  const old = { id: 'old', side: 'RIGHT' as const, ...finding('Shared issue') } as Parameters<typeof renderFindingComment>[0];
  const h = await panelSetup({ settings: { ...consensus(2), maxFindings: 5 }, bots: [{ slot: 2 }],
    findings: { 'main-model': [finding('Shared issue'), { ...finding('Other issue'), path: 'src/other.ts' }], 'bot2-model': [finding('Shared issue'), { ...finding('Other issue'), path: 'src/other.ts' }] },
    rejectedModels: ['main-model', 'bot2-model'],
    comments: [{ id: 1, path: 'src/app.ts', line: 2, user: { login: PUBLISHER }, body: renderFindingComment(old, { language: 'en', suggestionsAsCode: false }) }] });
  await processReviewJob(h.job, h.deps);
  expect(h.created[0]!.comments).toHaveLength(0);
  expect(h.created[0]!.body).toContain('Other issue');
  expect(h.created[0]!.body).not.toContain('Shared issue');
});


it('leaves a lone verifier rejection in the rejection list without publishing it', async () => {
  const h = await panelSetup({ settings: consensus(1), bots: [{ slot: 2 }], findings: { 'main-model': [finding('Lonely rejected claim')] }, rejectedModels: ['main-model'] });
  await processReviewJob(h.job, h.deps);
  expect(h.created[0]!.comments).toHaveLength(0);
  expect(h.created[0]!.body).toContain('Rejected by verification');
  expect(h.created[0]!.body).toContain('Lonely rejected claim');
});
